/**
 * Machine-local GitHub OAuth for **git remote authentication** (push/pull/fetch/clone over
 * github.com HTTPS). Deliberately isolated from the pi/omp agent-model OAuth.
 */

export type { GitHubLoginCallbacks } from "./github-auth-service";
export { GitHubAuthService, getGitHubAuthService } from "./github-auth-service";
export { getGitHubAuthFilePath } from "./github-auth-store";
export type { GitHubAuthStatus } from "./github-auth-types";
export type { DeviceCodeGrant } from "./github-device-flow";
export { resolveGitHubOAuthClientId } from "./github-device-flow";
export type { GitHubGitAuthInjector, GitHubGitInjection } from "./github-git-credentials";
