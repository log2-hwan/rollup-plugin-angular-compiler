import { Component } from '@angular/core';
import { Route } from '@angular/router';

@Component({
  standalone: true,
  selector: 'page-app',
  template: '<div>Hello Page</div>',
})
export class PageSubAppComponent {}

export const ROUTES: Route[] = [{ path: '', pathMatch: 'full', component: PageSubAppComponent }];
