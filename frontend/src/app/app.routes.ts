import { Routes } from '@angular/router';
import { ScenarioListComponent } from './features/scenario-list/scenario-list';
import { ScenarioDetailComponent } from './features/scenario-detail/scenario-detail';
import { ScenarioEditorComponent } from './features/scenario-editor/scenario-editor';
import { PublicStatusComponent } from './features/public-status/public-status';

export const routes: Routes = [
  { path: '', component: ScenarioListComponent },
  { path: 'scenario/:name', component: ScenarioDetailComponent },
  { path: 'scenario/:name/edit', component: ScenarioEditorComponent },
  { path: 'public/status/:name', component: PublicStatusComponent },
];
