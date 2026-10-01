import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";

/**
 * Quem está chamando? Autenticação não faz parte deste desafio, então hoje
 * ninguém é identificado. O desenho pretendido (ver ARCHITECTURE.md):
 *
 *  - Keycloak como IdP; cada provedor é um client OAuth2 (client credentials);
 *  - a implementação real valida o JWT (assinatura via JWKS, iss, aud, exp)
 *    e devolve o `client_id` do token;
 *  - o guard exige que esse client_id seja igual ao `providerId` do corpo,
 *    para um provedor não conseguir lançar transações em nome de outro.
 */
export interface ProviderIdentityPort {
    /** providerId autenticado, ou undefined se não houver autenticação configurada. */
    resolve(authorizationHeader: string | undefined): Promise<string | undefined>;
}

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

/** Implementação atual: não autentica ninguém. */
export class NoAuthProviderIdentity implements ProviderIdentityPort {
    async resolve(): Promise<string | undefined> {
        return undefined;
    }
}

/** Ponto de extensão: com a implementação no-op, deixa tudo passar. */
@Injectable()
export class AuthGuard implements CanActivate {
    constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; body?: { providerId?: unknown } }>();
        const providerId = await this.identity.resolve(request.headers.authorization);
        if (providerId === undefined) return true; // sem autenticação configurada

        return request.body?.providerId === undefined || request.body.providerId === providerId;
    }
}
