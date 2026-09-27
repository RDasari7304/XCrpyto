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
    url: string | null;
    at: string;
  }>;
  received: Array<{
    from: string | null;
    fromWallet?: string | null;
    avatar: string | null;
    amount: string;
    token: string;
    logo: string | null;
    signature: string | null;
    url: string | null;
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
  chain: 'solana' | 'robinhood' | 'bsc' | 'ethereum' | 'polygon' | 'hyperevm';
  contract: string | null;
  amountBase: string;
  route: 'direct' | 'escrow';
  status: string;
  expiresAt: string;
  recipientWallet: string | null;
  signature: string | null;
  explorerTx?: string;
}

export interface Preflight {
  ok: boolean;
  problems: string[];
  senderWallet: string;
  sol: string;
  token: string | null;
  setupSol: string | null;
}

export const getPreflight = (id: string) => request<Preflight>(`/api/intents/${id}/preflight`);

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

// ------------------------------------------------------------ members & send

export interface Member {
  id: string;
  handle: string;
  avatar: string | null;
  wallet: string | null;
  joinedAt: string;
}

export const listMembers = (before?: string) =>
  request<{ total: number; withWallet: number; users: Member[]; nextBefore: string | null }>(
    `/api/users${before ? `?before=${encodeURIComponent(before)}` : ''}`,
  );

export interface Recipient {
  id: string;
  handle: string;
  avatar: string | null;
  wallet: string;
}

export const searchUsers = (q: string) =>
  request<{ users: Recipient[] }>(`/api/users/search?q=${encodeURIComponent(q)}`);

export interface TokenBalance {
  symbol: string;
  name: string;
  logo: string | null;
  decimals: number;
  balance: string; // base units
  display: string;
  transferFeeBps: number;
}

export const getBalances = () =>
  request<{ wallet: string | null; lamports?: string; tokens: TokenBalance[] }>('/api/balances');

export const createTransfer = (body: { toUserId: string; token: string; amount: string }) =>
  request<{ id: string }>('/api/intents', { method: 'POST', body: JSON.stringify(body) });

// -------------------------------------------------------- payment requests

export interface PaymentRequest {
  id: string;
  link: string;
  requester: string | null;
  requesterAvatar: string | null;
  amount: string;
  token: string;
  logo: string | null;
  note: string | null;
  status: 'open' | 'paid' | 'cancelled';
  paidBy: string | null;
  paidByWallet?: string | null;
  txUrl: string | null;
  createdAt: string;
  paidAt: string | null;
  payable?: boolean;
}

export const createRequest = (body: { token: string; amount: string; note: string }) =>
  request<{ id: string; link: string }>('/api/requests', { method: 'POST', body: JSON.stringify(body) });

export const myRequests = () => request<{ requests: PaymentRequest[] }>('/api/requests');

export const getRequest = (id: string) => request<PaymentRequest>(`/api/requests/${id}`);

export const payRequest = (id: string) =>
  request<{ intentId: string }>(`/api/requests/${id}/pay`, { method: 'POST' });

export const cancelRequest = (id: string) =>
  request<{ status: string }>(`/api/requests/${id}/cancel`, { method: 'POST' });

/** Prefilled X post for sharing a pay link. */
export function shareOnX(r: { amount: string; token: string; note: string | null; link: string }): string {
  const text = `Pay me ${r.amount} ${r.token}${r.note ? ` for ${r.note}` : ''} on XLedger 👇`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(r.link)}`;
}

// ------------------------------------------------------ Solana Actions

/** One button or form in an Action's GET response. */
export interface ActionLink {
  type: 'transaction' | 'post' | 'external-link';
  label: string;
  href: string;
  parameters?: Array<{
    type?: 'number' | 'text' | 'select';
    name: string;
    label?: string;
    required?: boolean;
    min?: number;
    options?: Array<{ label: string; value: string; selected?: boolean }>;
  }>;
}

export interface ActionMeta {
  type: 'action' | 'completed';
  icon: string;
  title: string;
  description: string;
  label: string;
  disabled?: boolean;
  links?: { actions: ActionLink[] };
}

async function actionFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message ?? body.error ?? 'Something went wrong');
  return body as T;
}

export const getAction = (path: string) => actionFetch<ActionMeta>(path);

export const postAction = (href: string, account: string) =>
  actionFetch<{ transaction: string; message?: string; links?: { next?: { href: string } } }>(href, {
    method: 'POST',
    body: JSON.stringify({ account }),
  });

export const confirmAction = (href: string, account: string, signature: string) =>
  actionFetch<ActionMeta>(href, { method: 'POST', body: JSON.stringify({ account, signature }) });

/** Public RPC + cluster, for pages used by people who aren't signed in. */
export const getPublicConfig = () => actionFetch<{ rpcUrl: string; cluster: string }>('/api/config');

export const tipJarUrl = (handle: string) => `${window.location.origin}/tip/${handle}`;
export const blinkUrl = (apiPath: string) =>
  `https://dial.to/?action=${encodeURIComponent(`solana-action:${window.location.origin}${apiPath}`)}`;
