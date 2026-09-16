export type AuthUser = {
  userId: string;
  sub?: string;
  roles: string[];
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
