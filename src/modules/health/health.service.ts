import { Injectable } from '@nestjs/common';
type HealthT = {
  status: 'OK';
  service: 'Notification SAAS';
};
@Injectable()
export class HealthService {
  check(): HealthT {
    return {
      status: 'OK',
      service: 'Notification SAAS',
    };
  }
}
