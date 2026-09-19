// Empty string means same origin, which is how production is deployed. Local
// dev sets VITE_API_URL=http://localhost:3000 in web/.env.
const API = import.meta.env.VITE_API_URL ?? '';

let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as object) ?? {}) };
  if (init?.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers,
    credentials: 'include', // session cookie is httpOnly; JS never sees it
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'Something went wrong');
  return body as T;
}

export interface Account {
  handle: string | null;
  wallet: string | null;
  evmWallet: string | null;
  csrfToken: string;
  cluster: string;
  rpcUrl: string;
  botHandle: string;
  escrowEnabled: boolean;
  xSignInAvailable: boolean;
  pendingApprovals: Array<{
    id: string;
    to: string | null;
    amount: string;
    token: string;
    logo: string | null;
    route: string;
    expiresAt: string;
  }>;
  claimable: Array<{
    escrow: string;
    from: string | null;
    amount: string;
    token: string;
    refundableAfter: string;
  }>;
  sent: Array<{
    to: string | null;
    amount: string;
    token: string;
    logo: string | null;
    route: string;
    signature: string | null;
    at: string;
  }>;
}

export let runtimeRpcUrl: string | null = null;

export async function getAccount(): Promise<Account> {
  const account = await request<Account>('/api/me');
  csrfToken = account.csrfToken;
  runtimeRpcUrl = account.rpcUrl;
  return account;
}

export const loginUrl = (next?: string) =>
  `${API}/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`;

export const logout = () => request('/auth/logout', { method: 'POST' });

export const walletChallenge = () =>
  request<{ message: string; nonce: string }>('/api/wallet/challenge', { method: 'POST' });

export const walletVerify = (body: {
  wallet: string;
  message: string;
  signature: string;
  nonce: string;
}) => request<{ wallet: string }>('/api/wallet/verify', { method: 'POST', body: JSON.stringify(body) });

export const walletVerifyEvm = (body: {
  address: string;
  message: string;
  signature: string;
  nonce: string;
}) => request<{ address: string }>('/api/wallet/verify-evm', { method: 'POST', body: JSON.stringify(body) });

export interface IntentView {
  id: string;
  to: string | null;
  amount: string;
  token: string;
  logo: string | null;
  chain: 'solana' | 'robinhood' | 'bsc';
  contract: string | null;
  amountBase: string;
  route: 'direct' | 'escrow';
  status: string;
  expiresAt: string;
  recipientWallet: string | null;
  signature: string | null;
}

export const getIntent = (id: string) => request<IntentView>(`/api/intents/${id}`);

export const buildIntentTx = (id: string) =>
  request<{ base64: string; description: Record<string, string> }>(
    `/api/intents/${id}/transaction`,
    { method: 'POST' },
  );

export const confirmIntent = (id: string, signature: string) =>
  request<{ status: string }>(`/api/intents/${id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ signature }),
  });

export const buildClaimTx = (pda: string) =>
  request<{ base64: string; amount: string; token: string }>(`/api/claims/${pda}`, { method: 'POST' });

export const confirmClaim = (pda: string, signature: string) =>
  request<{ status: string }>(`/api/claims/${pda}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ signature }),
  });
