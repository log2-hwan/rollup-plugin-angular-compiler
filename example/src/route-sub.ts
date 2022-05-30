import { Component, NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'page-app',
  template: '<div>Hello Page</div>',
})
export class PageSubAppComponent {}

@NgModule({
  imports: [
    RouterModule.forChild([{ path: '', pathMatch: 'exact', component: PageSubAppComponent }]),
  ],
  declarations: [PageSubAppComponent],
  bootstrap: [PageSubAppComponent],
})
export class PageSubModule {}
