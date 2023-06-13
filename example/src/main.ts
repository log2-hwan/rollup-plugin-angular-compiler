import { Component } from '@angular/core';
import { RouterOutlet, provideRouter } from '@angular/router';
import { bootstrapApplication } from '@angular/platform-browser';
import 'zone.js';

@Component({
  standalone: true,
  imports: [RouterOutlet],
  selector: 'main-app',
  styleUrls: ['./main.less'],
  template: '<div>Hello</div><router-outlet></router-outlet>',
})
export class MainAppComponent {}

bootstrapApplication(MainAppComponent, {
  providers: [
    provideRouter([
      {
        path: '',
        pathMatch: 'full',
        loadChildren: () => import('./route').then(m => m.ROUTES),
      },
    ]),
  ],
});
