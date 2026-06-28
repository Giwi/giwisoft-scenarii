import { Routes } from '@angular/router';
import { ScenarioListComponent } from './scenario-list';
import { ScenarioDetailComponent } from './scenario-detail';
import { ScenarioEditorComponent } from './scenario-editor';
import { PublicStatusComponent } from './public-status';

export const routes: Routes = [
  { path: '', component: ScenarioListComponent },
  { path: 'scenario/:name', component: ScenarioDetailComponent },
  { path: 'scenario/:name/edit', component: ScenarioEditorComponent },
  { path: 'public/status/:name', component: PublicStatusComponent },
];
