import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';

@Controller('health')
export class AppController {
  @Public()
  @Get()
  health() {
    return {
      status: 'ok',
      service: 'campushub-backend',
      version: '0.1.0',
      time: new Date().toISOString(),
    };
  }
}
