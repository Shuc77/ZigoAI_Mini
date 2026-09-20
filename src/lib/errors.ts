/**
 * 统一错误约定：API 一律返回 { code, message }，HTTP 状态码表达语义。
 * 跨租户访问统一返回 404（而不是 403）—— 不暴露"这个 id 存在但不属于你"。
 */
export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code ?? defaultCode(status);
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return 'INTERNAL_ERROR';
  }
}

export const unauthorized = () => new HttpError(401, '请先登录');
export const notFound = (what = '资源') => new HttpError(404, `${what}不存在`);
export const badRequest = (message: string) => new HttpError(400, message);
export const forbidden = (message = '没有权限执行该操作') => new HttpError(403, message);
