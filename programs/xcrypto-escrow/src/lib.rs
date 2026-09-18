use anchor_lang::prelude::*;
use anchor_lang::system_program;

// Placeholder. Run `anchor keys sync` after generating the program keypair;
// it rewrites this line and Anchor.toml with the real program id.
declare_id!("11111111111111111111111111111111");

/// Claimable tips for X accounts that have not connected a wallet yet.
///
/// Custody model: lamports sit in a program-owned PDA. Nobody — not the sender,
/// not the app's backend — can move them except along two paths this program
/// allows:
///
///   claim:  requires BOTH the recipient's wallet signature AND the attestor's.
///           The attestor is an identity oracle only: it attests "this wallet
///           belongs to X user N". It cannot redirect funds, because the
///           recipient must sign too, and the recipient is the only account
///           that can receive.
///   refund: after `expires_at`, the sender takes everything back. No
///           attestation needed, so a backend that vanishes cannot strand funds.
///
/// The attestor pubkey is written into the escrow by the sender at creation, so
/// the sender chooses who they trust rather than the program hardcoding it.
#[program]
pub mod xcrypto_escrow {
    use super::*;

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        recipient_x_hash: [u8; 32],
        amount: u64,
        nonce: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, EscrowError::ExpiryInPast);
        require!(
            expires_at <= now + MAX_ESCROW_SECONDS,
            EscrowError::ExpiryTooFar
        );

        // Move the tip in on top of the rent the sender already paid on init.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.sender = ctx.accounts.sender.key();
        escrow.attestor = ctx.accounts.attestor.key();
        escrow.recipient_x_hash = recipient_x_hash;
        escrow.amount = amount;
        escrow.nonce = nonce;
        escrow.expires_at = expires_at;
        escrow.bump = ctx.bumps.escrow;

        emit!(EscrowCreated {
            escrow: escrow.key(),
            sender: escrow.sender,
            recipient_x_hash,
            amount,
        });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let amount = ctx.accounts.escrow.amount;
        let escrow_key = ctx.accounts.escrow.key();

        // Pay the tip out of the PDA's lamports. The remaining rent goes back
        // to the sender when Anchor closes the account.
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();
        **escrow_info.try_borrow_mut_lamports()? = escrow_info
            .lamports()
            .checked_sub(amount)
            .ok_or(EscrowError::MathOverflow)?;
        **recipient_info.try_borrow_mut_lamports()? = recipient_info
            .lamports()
            .checked_add(amount)
            .ok_or(EscrowError::MathOverflow)?;

        emit!(EscrowClaimed {
            escrow: escrow_key,
            recipient: ctx.accounts.recipient.key(),
            amount,
        });
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.escrow.expires_at,
            EscrowError::NotYetExpired
        );
        emit!(EscrowRefunded {
            escrow: ctx.accounts.escrow.key(),
            sender: ctx.accounts.sender.key(),
            amount: ctx.accounts.escrow.amount,
        });
        // close = sender returns tip + rent in one go.
        Ok(())
    }
}

pub const MAX_ESCROW_SECONDS: i64 = 60 * 60 * 24 * 90;

#[account]
pub struct Escrow {
    pub sender: Pubkey,
    pub attestor: Pubkey,
    pub recipient_x_hash: [u8; 32],
    pub amount: u64,
    pub nonce: u64,
    pub expires_at: i64,
    pub bump: u8,
}

impl Escrow {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1;
}

#[derive(Accounts)]
#[instruction(recipient_x_hash: [u8; 32], amount: u64, nonce: u64)]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = sender,
        space = Escrow::LEN,
        seeds = [b"escrow", sender.key().as_ref(), recipient_x_hash.as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub sender: Signer<'info>,
    /// CHECK: stored only; never signs here. Recorded so `claim` can require it.
    pub attestor: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        close = sender,
        seeds = [b"escrow", escrow.sender.as_ref(), escrow.recipient_x_hash.as_ref(), &escrow.nonce.to_le_bytes()],
        bump = escrow.bump,
        has_one = sender,
        has_one = attestor,
    )]
    pub escrow: Account<'info, Escrow>,
    /// Gets the rent deposit back once the escrow closes.
    #[account(mut)]
    pub sender: SystemAccount<'info>,
    /// The only account that can receive the tip, and it must sign.
    #[account(mut)]
    pub recipient: Signer<'info>,
    /// Identity oracle. Signs to assert `recipient` owns the X account.
    pub attestor: Signer<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        close = sender,
        seeds = [b"escrow", escrow.sender.as_ref(), escrow.recipient_x_hash.as_ref(), &escrow.nonce.to_le_bytes()],
        bump = escrow.bump,
        has_one = sender,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub sender: Signer<'info>,
}

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub sender: Pubkey,
    pub recipient_x_hash: [u8; 32],
    pub amount: u64,
}

#[event]
pub struct EscrowClaimed {
    pub escrow: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowRefunded {
    pub escrow: Pubkey,
    pub sender: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Expiry must be in the future")]
    ExpiryInPast,
    #[msg("Expiry is too far in the future")]
    ExpiryTooFar,
    #[msg("Escrow has not expired yet")]
    NotYetExpired,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
