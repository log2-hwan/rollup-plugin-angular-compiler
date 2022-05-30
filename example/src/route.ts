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
        pathMatch: 'exact',
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
  bootstrap: [PageAppComponent],
})
export class PageModule {}
