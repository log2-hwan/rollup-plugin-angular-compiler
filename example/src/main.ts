import { Component, NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { BrowserModule, platformBrowser } from '@angular/platform-browser';
import 'zone.js';

@Component({
  selector: 'main-app',
  styleUrls: ['./main.less'],
  template: '<div>Hello</div><router-outlet></router-outlet>',
})
export class MainAppComponent {}

@NgModule({
  imports: [
    BrowserModule,
    RouterModule.forRoot([
      {
        path: '',
        pathMatch: 'exact',
        loadChildren: () => import('./route').then(m => m.PageModule),
      },
    ]),
  ],
  declarations: [MainAppComponent],
  bootstrap: [MainAppComponent],
})
export class MainModule {}

platformBrowser().bootstrapModule(MainModule);
