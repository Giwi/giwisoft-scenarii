import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth';

// Blocks private routes until the session status is known; unauthenticated users land on /login.
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.load();
  if (auth.status().authenticated) return true;
  return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

// Like authGuard, but also requires the admin role. Plain users are sent back to the list.
export const adminGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.load();
  if (!auth.status().authenticated) return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
  if (auth.isAdmin()) return true;
  return router.createUrlTree(['/scenarios']);
};
