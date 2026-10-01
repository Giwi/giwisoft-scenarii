import { Routes } from '@angular/router';
import { ScenarioListComponent } from './features/scenario-list/scenario-list';
import { ScenarioDetailComponent } from './features/scenario-detail/scenario-detail';
import { ScenarioEditorComponent } from './features/scenario-editor/scenario-editor';
import { PublicStatusComponent } from './features/public-status/public-status';
import { LandingComponent } from './features/landing/landing';
import { UsersComponent } from './features/users/users';
import { authGuard, adminGuard } from './shared/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LandingComponent },
  { path: 'scenarios', component: ScenarioListComponent, canActivate: [authGuard] },
  { path: 'users', component: UsersComponent, canActivate: [adminGuard] },
  { path: 'scenario/:name', component: ScenarioDetailComponent, canActivate: [authGuard] },
  { path: 'scenario/:name/edit', component: ScenarioEditorComponent, canActivate: [authGuard] },
  // Public status pages stay reachable without a session.
  { path: 'public/status/:name', component: PublicStatusComponent },
  { path: '', pathMatch: 'full', redirectTo: 'scenarios' },
  { path: '**', redirectTo: 'scenarios' },
];
