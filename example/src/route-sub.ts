import { Component, NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'page-app',
  template: '<div>Hello Page</div>',
})
export class PageSubAppComponent {}

@NgModule({
  imports: [
    RouterModule.forChild([{ path: '', pathMatch: 'full', component: PageSubAppComponent }]),
  ],
  declarations: [PageSubAppComponent],
})
export class PageSubModule {}
