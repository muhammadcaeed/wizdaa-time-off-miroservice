import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthorizationService } from './authorization.service';
import { EmployeeRepository } from './employee.repository';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { TokenService } from './token.service';

/**
 * Authentication + authorization wiring (ADR-003). Global so the guards,
 * {@link TokenService}, and {@link AuthorizationService} are injectable
 * everywhere. {@link TokenService} is built from the validated env (HS256 key +
 * lifetime). The guards are registered as `APP_GUARD`s in the root module.
 */
@Global()
@Module({
  providers: [
    EmployeeRepository,
    AuthorizationService,
    JwtAuthGuard,
    RolesGuard,
    {
      provide: TokenService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new TokenService(
          config.getOrThrow<string>('JWT_SIGNING_KEY'),
          config.getOrThrow<number>('JWT_LIFETIME_SECONDS'),
        ),
    },
  ],
  exports: [TokenService, AuthorizationService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
