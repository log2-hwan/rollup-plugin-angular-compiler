import { Component } from '@angular/core';
import { Route, RouterOutlet } from '@angular/router';

@Component({
  standalone: true,
  imports: [RouterOutlet],
  selector: 'page-app',
  template: '<router-outlet></router-outlet>',
})
export class PageAppComponent {}

export const ROUTES: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    component: PageAppComponent,
    children: [
      {
        path: '',
        loadChildren: () => import('./route-sub').then(m => m.ROUTES),
      },
    ],
  },
];
