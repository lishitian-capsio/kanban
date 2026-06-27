/**
 * Machine-local Gitee Personal Access Token (PAT) for **git remote authentication** (push/
 * pull/fetch/clone over gitee.com HTTPS). Deliberately isolated from the pi/omp agent-model
 * OAuth. Gitee has no OAuth device flow, so this is a pasted-PAT module (decision cf0d6) —
 * the GitHub module's device-flow/pending-login machinery has no Gitee counterpart.
 */

export { fetchGiteeUserLogin } from "./gitee-api";
export type { GiteeLoginInput } from "./gitee-auth-service";
export { GiteeAuthService, getGiteeAuthService } from "./gitee-auth-service";
export { getGiteeAuthFilePath } from "./gitee-auth-store";
export type { GiteeAuthStatus } from "./gitee-auth-types";
export type { GiteeGitAuthInjector, GiteeGitInjection } from "./gitee-git-credentials";
