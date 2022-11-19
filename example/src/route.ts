import { Component, NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'page-app',
  template: '<router-outlet></router-outlet>',
})
export class PageAppComponent {}

@NgModule({
  imports: [
    RouterModule.forChild([
      {
        path: '',
        pathMatch: 'full',
        component: PageAppComponent,
        children: [
          {
            path: '',
            loadChildren: () => import('./route-sub').then(m => m.PageSubModule),
          },
        ],
      },
    ]),
  ],
  declarations: [PageAppComponent],
})
export class PageModule {}
