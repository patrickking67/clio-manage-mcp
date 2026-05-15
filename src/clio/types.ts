/**
 * Shared Clio v4 wire-format types.
 *
 * Clio wraps every list response in `{ data: [...], meta: { paging: {...} } }`
 * and every single-resource response in `{ data: {...} }`.
 */

export interface ClioPaging {
  previous?: string;
  next?: string;
  records?: number;
}

export interface ClioMeta {
  paging?: ClioPaging;
  records?: number;
}

export interface ClioListResponse<T> {
  data: T[];
  meta?: ClioMeta;
}

export interface ClioSingleResponse<T> {
  data: T;
  meta?: ClioMeta;
}

export interface ClioErrorBody {
  error?: {
    type?: string;
    message?: string;
    code?: string | number;
    details?: unknown;
  };
}
