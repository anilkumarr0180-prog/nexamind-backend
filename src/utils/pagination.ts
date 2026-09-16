export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type PaginationOptions = {
  page?: number | undefined;
  limit?: number | undefined;
};

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

export type PaginatedResult<T> = T[] & {
  pagination: PaginationMeta;
  items: T[];
  total: number;
};

export const calculatePagination = (
  total: number,
  page: number,
  limit: number,
): PaginationMeta => {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

export const toPaginatedResult = <T>(
  items: T[],
  pagination: PaginationMeta,
): PaginatedResult<T> => {
  return Object.assign(items, {
    pagination,
    items,
    total: pagination.total,
  });
};
