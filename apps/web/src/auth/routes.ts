import type { authRoutes } from '@omnibridge/contract';
import { ApiError } from '@omnibridge/core';
import type { Handlers } from '../contract.ts';
import type { AuthService } from './service.ts';

/** Auth answers are never cached (ADR-048: the enrolment secret above all). */
function headers(cookies: readonly string[] = []) {
  return {
    'cache-control': 'no-store',
    ...(cookies.length === 0 ? {} : { 'set-cookie': cookies }),
  };
}

const unavailable = () =>
  Promise.reject(new ApiError({ status: 503, code: 'service_unavailable' }));

/**
 * The handlers of the auth routes (T-0203). Without an AuthService (tests that stub the session)
 * they answer 503, never a fake success.
 */
export function authHandlers(auth: AuthService | undefined): Handlers<typeof authRoutes> {
  if (auth === undefined) {
    return {
      getCsrf: unavailable,
      signIn: unavailable,
      verifyMfa: unavailable,
      useRecoveryCode: unavailable,
      startMfaEnrolment: unavailable,
      confirmMfaEnrolment: unavailable,
      forgotPassword: unavailable,
      getPasswordReset: unavailable,
      resetPassword: unavailable,
      listMyWorkspaces: unavailable,
      chooseWorkspace: unavailable,
      enterPlatform: unavailable,
      changePassword: unavailable,
      signOut: unavailable,
      signOutEverywhere: unavailable,
    };
  }
  return {
    getCsrf: ({ request }) =>
      Promise.resolve({ status: 204, body: null, headers: headers(auth.csrfCookie(request)) }),
    signIn: async ({ body, request }) => {
      const { body: result, cookies } = await auth.signIn(body, request.ip);
      return { status: 200, body: result, headers: headers(cookies) };
    },
    verifyMfa: async ({ body, request, account }) => {
      const { body: result, cookies } = await auth.verifyMfa(request, account, body.code);
      return { status: 200, body: result, headers: headers(cookies) };
    },
    useRecoveryCode: async ({ body, request, account }) => {
      const { body: result, cookies } = await auth.useRecoveryCode(request, account, body.code);
      return { status: 200, body: result, headers: headers(cookies) };
    },
    startMfaEnrolment: async ({ account }) => ({
      status: 200,
      body: await auth.startEnrolment(account),
      headers: headers(),
    }),
    confirmMfaEnrolment: async ({ body, request, account }) => {
      const { body: result, cookies } = await auth.confirmEnrolment(request, account, body.code);
      return { status: 200, body: result, headers: headers(cookies) };
    },
    forgotPassword: async ({ body }) => {
      await auth.forgotPassword(body.email);
      return { status: 202, body: null, headers: headers() };
    },
    getPasswordReset: async ({ params }) => ({
      status: 200,
      body: await auth.resetInfo(params.token),
      headers: headers(),
    }),
    resetPassword: async ({ body }) => {
      await auth.resetPassword(body.token, body.password);
      return { status: 204, body: null, headers: headers() };
    },
    listMyWorkspaces: async ({ account }) => ({
      status: 200,
      body: await auth.workspaces(account),
      headers: headers(),
    }),
    chooseWorkspace: async ({ body, request }) => ({
      status: 204,
      body: null,
      headers: headers(await auth.chooseWorkspace(request, body.workspaceId)),
    }),
    enterPlatform: async ({ request, account }) => ({
      status: 204,
      body: null,
      headers: headers(await auth.enterPlatform(request, account)),
    }),
    changePassword: async ({ body, account }) => ({
      status: 204,
      body: null,
      headers: headers(await auth.changePassword(account, body)),
    }),
    signOut: async ({ request }) => ({
      status: 204,
      body: null,
      headers: headers(await auth.signOut(request)),
    }),
    signOutEverywhere: async ({ request, account }) => ({
      status: 204,
      body: null,
      headers: headers(await auth.signOutEverywhere(request, account)),
    }),
  };
}
