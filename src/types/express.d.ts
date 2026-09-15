export type AuthUser = {
  userId: string;
  roles: string[];
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
