/** Account metadata is local to the user's Mac. Credentials are deliberately never persisted. */
export interface GameAccount {
  id: string;
  gameId: string;
  packageName: string;
  name: string;
  server: string;
  role: string;
  note: string;
  enabled: boolean;
  binding: { index: number; instanceCreatedAt: string } | null;
  login: {
    status: 'pending' | 'ready';
    attemptId: string | null;
    verifiedAt: number | null;
  };
  createdAt: number;
  updatedAt: number;
}

export interface AccountDetails {
  name: string;
  server?: string;
  role?: string;
  note?: string;
}

export interface LoginScreen {
  step: 'phone' | 'code' | 'game' | 'manual';
  message: string;
  phoneMasked?: string;
  retryAt?: number;
}

export type LoginPhase = 'preparing' | 'starting' | 'awaitingLogin' | 'verifying' | 'completed' | 'cancelled' | 'failed';

export interface AccountLoginSession {
  id: string;
  accountId: string;
  accountName: string;
  gameId: string;
  index: number;
  phase: LoginPhase;
  message: string;
  screen?: LoginScreen;
  updatedAt: number;
}

export type AccountLoginCommand =
  | { requestId: string; action: 'inspect' }
  | { requestId: string; action: 'requestSms'; phone: string; agreementAccepted: boolean }
  | { requestId: string; action: 'submitCode'; code: string }
  | { requestId: string; action: 'resendCode' };

export function loginActive(phase: LoginPhase): boolean {
  return phase === 'preparing' || phase === 'starting' || phase === 'awaitingLogin' || phase === 'verifying';
}
