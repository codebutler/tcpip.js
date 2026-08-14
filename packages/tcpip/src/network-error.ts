export type NetworkErrorCode = 'ENETUNREACH' | 'EMSGSIZE';

export class NetworkError extends Error {
  readonly code: NetworkErrorCode;

  constructor(code: NetworkErrorCode, message: string) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
  }
}
