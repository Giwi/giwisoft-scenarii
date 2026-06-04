import { Routes } from '@angular/router';
import { ScenarioListComponent } from './scenario-list';
import { ScenarioDetailComponent } from './scenario-detail';

export const routes: Routes = [
  { path: '', component: ScenarioListComponent },
  { path: 'scenario/:name', component: ScenarioDetailComponent },
];
