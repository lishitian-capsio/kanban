// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type {
	RuntimeAgentExecutablePathResponse,
	RuntimeAgentExecutablePathSaveRequest,
	RuntimeAgentProviderConfigListResponse,
	RuntimeAgentProviderConfigSaveRequest,
	RuntimeAgentProviderMutationRequest,
	RuntimeAgentProviderMutationResponse,
	RuntimeAgentProviderSetListResponse,
	RuntimeArtifactContentRequest,
	RuntimeArtifactContentResponse,
	RuntimeArtifactsRequest,
	RuntimeArtifactsResponse,
	RuntimeBoardAutoSyncRequest,
	RuntimeBoardAutoSyncResponse,
	RuntimeBoardBranchUpdateRequest,
	RuntimeBoardBranchUpdateResponse,
	RuntimeBoardSyncActionRequest,
	RuntimeBoardSyncActionResponse,
	RuntimeBoardSyncStatusResponse,
	RuntimeCommandRunRequest,
	RuntimeCommandRunResponse,
	RuntimeConfigResponse,
	RuntimeConfigSaveRequest,
	RuntimeDbBrowseRequest,
	RuntimeDbBrowseResponse,
	RuntimeDbConnectionAddRequest,
	RuntimeDbConnectionAddResponse,
	RuntimeDbConnectionListResponse,
	RuntimeDbConnectionRemoveRequest,
	RuntimeDbConnectionRemoveResponse,
	RuntimeDbConnectionTestRequest,
	RuntimeDbConnectionTestResponse,
	RuntimeDbDescribeRequest,
	RuntimeDbDescribeResponse,
	RuntimeDbQueryRequest,
	RuntimeDbQueryResponse,
	RuntimeDbTablesRequest,
	RuntimeDbTablesResponse,
	RuntimeDebugResetAllStateResponse,
	RuntimeDirectoryListRequest,
	RuntimeDirectoryListResponse,
	RuntimeFetchRemoteModelsRequest,
	RuntimeFetchRemoteModelsResponse,
	RuntimeFileAddRequest,
	RuntimeFileAddResponse,
	RuntimeFileBytesRequest,
	RuntimeFileBytesResponse,
	RuntimeFileDeleteRequest,
	RuntimeFileDeleteResponse,
	RuntimeFileGetRequest,
	RuntimeFileGetResponse,
	RuntimeFilePathRequest,
	RuntimeFilePathResponse,
	RuntimeFilesListResponse,
	RuntimeFileUpdateRequest,
	RuntimeFileUpdateResponse,
	RuntimeFsCreateEntryRequest,
	RuntimeFsDeleteEntryRequest,
	RuntimeFsDeleteEntryResponse,
	RuntimeFsDownloadEntryRequest,
	RuntimeFsDownloadEntryResponse,
	RuntimeFsEntryMutationResponse,
	RuntimeFsListDirRequest,
	RuntimeFsListDirResponse,
	RuntimeFsListPathsRequest,
	RuntimeFsListPathsResponse,
	RuntimeFsMoveRequest,
	RuntimeFsReadFileRequest,
	RuntimeFsReadFileResponse,
	RuntimeFsRenameRequest,
	RuntimeFsStatRequest,
	RuntimeFsStatResponse,
	RuntimeFsUploadFileRequest,
	RuntimeFsUploadFileResponse,
	RuntimeFsWriteFileRequest,
	RuntimeFsWriteFileResponse,
	RuntimeGitCheckoutRequest,
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitDiffRequest,
	RuntimeGitCommitDiffResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitLogRequest,
	RuntimeGitLogResponse,
	RuntimeGitRefsResponse,
	RuntimeGitRemoteResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeGitTagCreateRequest,
	RuntimeGitTagDeleteRequest,
	RuntimeGitTagMutationResponse,
	RuntimeGitUserIdentityResponse,
	RuntimeHomeChatFullscreenTabsResponse,
	RuntimeHomeChatFullscreenTabsSaveRequest,
	RuntimeHomeChatThreadBindImChannelRequest,
	RuntimeHomeChatThreadCloseRequest,
	RuntimeHomeChatThreadCreateRequest,
	RuntimeHomeChatThreadImChannelIdRequest,
	RuntimeHomeChatThreadImChannelResponse,
	RuntimeHomeChatThreadMutationResponse,
	RuntimeHomeChatThreadRenameRequest,
	RuntimeHomeChatThreadSetNextStepRequest,
	RuntimeHomeChatThreadSetTitleRequest,
	RuntimeHomeChatThreadsListResponse,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeImChatAddRequest,
	RuntimeImChatListResponse,
	RuntimeImChatMutationResponse,
	RuntimeImChatRemoveRequest,
	RuntimeKanbanMcpAuthStatusResponse,
	RuntimeKanbanMcpOAuthRequest,
	RuntimeKanbanMcpOAuthResponse,
	RuntimeKanbanMcpSettingsResponse,
	RuntimeKanbanMcpSettingsSaveRequest,
	RuntimeKanbanMcpSettingsSaveResponse,
	RuntimeKanbanProviderCatalogResponse,
	RuntimeKanbanProviderModelsRequest,
	RuntimeKanbanProviderModelsResponse,
	RuntimeOpenFileRequest,
	RuntimeOpenFileResponse,
	RuntimeProjectAddRequest,
	RuntimeProjectAddResponse,
	RuntimeProjectDirectoryPickerResponse,
	RuntimeProjectRemoveRequest,
	RuntimeProjectRemoveResponse,
	RuntimeProjectsResponse,
	RuntimeRunUpdateResponse,
	RuntimeSetGitRemoteRequest,
	RuntimeSetGitRemoteResponse,
	RuntimeSetGitUserIdentityRequest,
	RuntimeSetGitUserIdentityResponse,
	RuntimeShellSessionStartRequest,
	RuntimeShellSessionStartResponse,
	RuntimeSlashCommandsResponse,
	RuntimeTaskChatAbortRequest,
	RuntimeTaskChatAbortResponse,
	RuntimeTaskChatCancelRequest,
	RuntimeTaskChatCancelResponse,
	RuntimeTaskChatMessagesRequest,
	RuntimeTaskChatMessagesResponse,
	RuntimeTaskChatReloadRequest,
	RuntimeTaskChatReloadResponse,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskSessionAttachmentRequest,
	RuntimeTaskSessionAttachmentResponse,
	RuntimeTaskSessionInputRequest,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionStopRequest,
	RuntimeTaskSessionStopResponse,
	RuntimeTaskWorkspaceInfoRequest,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeUpdateStatusResponse,
	RuntimeVaultArchiveExportRequest,
	RuntimeVaultArchiveExportResponse,
	RuntimeVaultDocumentCreateRequest,
	RuntimeVaultDocumentCreateResponse,
	RuntimeVaultDocumentDeleteRequest,
	RuntimeVaultDocumentDeleteResponse,
	RuntimeVaultDocumentExportRequest,
	RuntimeVaultDocumentExportResponse,
	RuntimeVaultDocumentGetRequest,
	RuntimeVaultDocumentGetResponse,
	RuntimeVaultDocumentLinksGetRequest,
	RuntimeVaultDocumentLinksGetResponse,
	RuntimeVaultDocumentsListRequest,
	RuntimeVaultDocumentsListResponse,
	RuntimeVaultDocumentUpdateRequest,
	RuntimeVaultDocumentUpdateResponse,
	RuntimeVaultSearchRequest,
	RuntimeVaultSearchResponse,
	RuntimeVaultSettingsGetResponse,
	RuntimeVaultSettingsUpdateRequest,
	RuntimeVaultSettingsUpdateResponse,
	RuntimeVaultViewCreateRequest,
	RuntimeVaultViewCreateResponse,
	RuntimeVaultViewDeleteRequest,
	RuntimeVaultViewDeleteResponse,
	RuntimeVaultViewsListRequest,
	RuntimeVaultViewsListResponse,
	RuntimeVaultViewUpdateRequest,
	RuntimeVaultViewUpdateResponse,
	RuntimeWorkspaceAttachmentDeleteFileRequest,
	RuntimeWorkspaceAttachmentDeleteRequest,
	RuntimeWorkspaceAttachmentDeleteResponse,
	RuntimeWorkspaceAttachmentRequest,
	RuntimeWorkspaceAttachmentsListResponse,
	RuntimeWorkspaceChangesRequest,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileSearchRequest,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateNotifyResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
	RuntimeWorktreeDeleteRequest,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureRequest,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import {
	runtimeAgentExecutablePathResponseSchema,
	runtimeAgentExecutablePathSaveRequestSchema,
	runtimeAgentProviderConfigListResponseSchema,
	runtimeAgentProviderConfigSaveRequestSchema,
	runtimeAgentProviderMutationRequestSchema,
	runtimeAgentProviderMutationResponseSchema,
	runtimeAgentProviderSetListResponseSchema,
	runtimeArtifactContentRequestSchema,
	runtimeArtifactContentResponseSchema,
	runtimeArtifactsRequestSchema,
	runtimeArtifactsResponseSchema,
	runtimeBoardAutoSyncRequestSchema,
	runtimeBoardAutoSyncResponseSchema,
	runtimeBoardBranchUpdateRequestSchema,
	runtimeBoardBranchUpdateResponseSchema,
	runtimeBoardSyncActionRequestSchema,
	runtimeBoardSyncActionResponseSchema,
	runtimeBoardSyncStatusResponseSchema,
	runtimeCommandRunRequestSchema,
	runtimeCommandRunResponseSchema,
	runtimeConfigResponseSchema,
	runtimeConfigSaveRequestSchema,
	runtimeDbBrowseRequestSchema,
	runtimeDbBrowseResponseSchema,
	runtimeDbBrowseTableRequestSchema,
	runtimeDbBrowseTableResponseSchema,
	runtimeDbConnectionAddRequestSchema,
	runtimeDbConnectionAddResponseSchema,
	runtimeDbConnectionListResponseSchema,
	runtimeDbConnectionRemoveRequestSchema,
	runtimeDbConnectionRemoveResponseSchema,
	runtimeDbConnectionsListResponseSchema,
	runtimeDbConnectionTestRequestSchema,
	runtimeDbConnectionTestResponseSchema,
	runtimeDbDeleteConnectionRequestSchema,
	runtimeDbDeleteConnectionResponseSchema,
	runtimeDbDeleteRowRequestSchema,
	runtimeDbDescribeRequestSchema,
	runtimeDbDescribeResponseSchema,
	runtimeDbInsertRowRequestSchema,
	runtimeDbIntrospectRequestSchema,
	runtimeDbIntrospectResponseSchema,
	runtimeDbPreviewWriteRequestSchema,
	runtimeDbPreviewWriteResponseSchema,
	runtimeDbQueryRequestSchema,
	runtimeDbQueryResponseSchema,
	runtimeDbTablesRequestSchema,
	runtimeDbTablesResponseSchema,
	runtimeDbTestConnectionRequestSchema,
	runtimeDbTestConnectionResponseSchema,
	runtimeDbUpdateRowRequestSchema,
	runtimeDbUpsertConnectionRequestSchema,
	runtimeDbUpsertConnectionResponseSchema,
	runtimeDbWriteResponseSchema,
	runtimeDebugResetAllStateResponseSchema,
	runtimeDirectoryListRequestSchema,
	runtimeDirectoryListResponseSchema,
	runtimeFetchRemoteModelsRequestSchema,
	runtimeFetchRemoteModelsResponseSchema,
	runtimeFileAddRequestSchema,
	runtimeFileAddResponseSchema,
	runtimeFileBytesRequestSchema,
	runtimeFileBytesResponseSchema,
	runtimeFileDeleteRequestSchema,
	runtimeFileDeleteResponseSchema,
	runtimeFileGetRequestSchema,
	runtimeFileGetResponseSchema,
	runtimeFilePathRequestSchema,
	runtimeFilePathResponseSchema,
	runtimeFilesListResponseSchema,
	runtimeFileUpdateRequestSchema,
	runtimeFileUpdateResponseSchema,
	runtimeFsCreateEntryRequestSchema,
	runtimeFsDeleteEntryRequestSchema,
	runtimeFsDeleteEntryResponseSchema,
	runtimeFsDownloadEntryRequestSchema,
	runtimeFsDownloadEntryResponseSchema,
	runtimeFsEntryMutationResponseSchema,
	runtimeFsListDirRequestSchema,
	runtimeFsListDirResponseSchema,
	runtimeFsListPathsRequestSchema,
	runtimeFsListPathsResponseSchema,
	runtimeFsMoveRequestSchema,
	runtimeFsReadFileRequestSchema,
	runtimeFsReadFileResponseSchema,
	runtimeFsRenameRequestSchema,
	runtimeFsStatRequestSchema,
	runtimeFsStatResponseSchema,
	runtimeFsUploadFileRequestSchema,
	runtimeFsUploadFileResponseSchema,
	runtimeFsWriteFileRequestSchema,
	runtimeFsWriteFileResponseSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeGitCheckoutResponseSchema,
	runtimeGitCommitDiffRequestSchema,
	runtimeGitCommitDiffResponseSchema,
	runtimeGitDiscardResponseSchema,
	runtimeGiteeAuthStatusSchema,
	runtimeGiteeLogoutResponseSchema,
	runtimeGiteeSetTokenRequestSchema,
	runtimeGiteeSetTokenResponseSchema,
	runtimeGithubAuthStatusSchema,
	runtimeGithubBeginLoginResponseSchema,
	runtimeGithubLogoutResponseSchema,
	runtimeGithubPendingLoginResponseSchema,
	runtimeGithubPollLoginResponseSchema,
	runtimeGitLogRequestSchema,
	runtimeGitLogResponseSchema,
	runtimeGitRefsResponseSchema,
	runtimeGitRemoteResponseSchema,
	runtimeGitSummaryResponseSchema,
	runtimeGitSyncActionSchema,
	runtimeGitSyncResponseSchema,
	runtimeGitTagCreateRequestSchema,
	runtimeGitTagDeleteRequestSchema,
	runtimeGitTagMutationResponseSchema,
	runtimeGitUserIdentityResponseSchema,
	runtimeHomeChatFullscreenTabsResponseSchema,
	runtimeHomeChatFullscreenTabsSaveRequestSchema,
	runtimeHomeChatThreadBindImChannelRequestSchema,
	runtimeHomeChatThreadCloseRequestSchema,
	runtimeHomeChatThreadCreateRequestSchema,
	runtimeHomeChatThreadImChannelIdRequestSchema,
	runtimeHomeChatThreadImChannelResponseSchema,
	runtimeHomeChatThreadMutationResponseSchema,
	runtimeHomeChatThreadRenameRequestSchema,
	runtimeHomeChatThreadSetNextStepRequestSchema,
	runtimeHomeChatThreadSetTitleRequestSchema,
	runtimeHomeChatThreadsListResponseSchema,
	runtimeHookIngestRequestSchema,
	runtimeHookIngestResponseSchema,
	runtimeImChatAddRequestSchema,
	runtimeImChatListResponseSchema,
	runtimeImChatMutationResponseSchema,
	runtimeImChatRemoveRequestSchema,
	runtimeImClearCredentialsRequestSchema,
	runtimeImClearCredentialsResponseSchema,
	runtimeImCredentialStatusResponseSchema,
	runtimeImSetCredentialsRequestSchema,
	runtimeImSetCredentialsResponseSchema,
	runtimeKanbanMcpAuthStatusResponseSchema,
	runtimeKanbanMcpOAuthRequestSchema,
	runtimeKanbanMcpOAuthResponseSchema,
	runtimeKanbanMcpSettingsResponseSchema,
	runtimeKanbanMcpSettingsSaveRequestSchema,
	runtimeKanbanMcpSettingsSaveResponseSchema,
	runtimeKanbanProviderCatalogResponseSchema,
	runtimeKanbanProviderModelsRequestSchema,
	runtimeKanbanProviderModelsResponseSchema,
	runtimeOpenFileRequestSchema,
	runtimeOpenFileResponseSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectAddResponseSchema,
	runtimeProjectDirectoryPickerResponseSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeProjectRemoveResponseSchema,
	runtimeProjectsResponseSchema,
	runtimeRunUpdateResponseSchema,
	runtimeSetGitRemoteRequestSchema,
	runtimeSetGitRemoteResponseSchema,
	runtimeSetGitUserIdentityRequestSchema,
	runtimeSetGitUserIdentityResponseSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeShellSessionStartResponseSchema,
	runtimeSlashCommandsResponseSchema,
	runtimeStorageConnectionsListResponseSchema,
	runtimeStorageDeleteConnectionRequestSchema,
	runtimeStorageDeleteConnectionResponseSchema,
	runtimeStorageDownloadRequestSchema,
	runtimeStorageDownloadResponseSchema,
	runtimeStorageListRequestSchema,
	runtimeStorageListResponseSchema,
	runtimeStorageObjectContentSchema,
	runtimeStorageReadRequestSchema,
	runtimeStorageStatRequestSchema,
	runtimeStorageStatResponseSchema,
	runtimeStorageTestConnectionRequestSchema,
	runtimeStorageTestConnectionResponseSchema,
	runtimeStorageUpsertConnectionRequestSchema,
	runtimeStorageUpsertConnectionResponseSchema,
	runtimeTaskChatAbortRequestSchema,
	runtimeTaskChatAbortResponseSchema,
	runtimeTaskChatCancelRequestSchema,
	runtimeTaskChatCancelResponseSchema,
	runtimeTaskChatMessagesRequestSchema,
	runtimeTaskChatMessagesResponseSchema,
	runtimeTaskChatReloadRequestSchema,
	runtimeTaskChatReloadResponseSchema,
	runtimeTaskChatSendRequestSchema,
	runtimeTaskChatSendResponseSchema,
	runtimeTaskSessionAttachmentRequestSchema,
	runtimeTaskSessionAttachmentResponseSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionInputResponseSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStartResponseSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskSessionStopResponseSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTaskWorkspaceInfoResponseSchema,
	runtimeUpdateStatusResponseSchema,
	runtimeVaultArchiveExportRequestSchema,
	runtimeVaultArchiveExportResponseSchema,
	runtimeVaultDocumentCreateRequestSchema,
	runtimeVaultDocumentCreateResponseSchema,
	runtimeVaultDocumentDeleteRequestSchema,
	runtimeVaultDocumentDeleteResponseSchema,
	runtimeVaultDocumentExportRequestSchema,
	runtimeVaultDocumentExportResponseSchema,
	runtimeVaultDocumentGetRequestSchema,
	runtimeVaultDocumentGetResponseSchema,
	runtimeVaultDocumentLinksGetRequestSchema,
	runtimeVaultDocumentLinksGetResponseSchema,
	runtimeVaultDocumentsListRequestSchema,
	runtimeVaultDocumentsListResponseSchema,
	runtimeVaultDocumentUpdateRequestSchema,
	runtimeVaultDocumentUpdateResponseSchema,
	runtimeVaultSearchRequestSchema,
	runtimeVaultSearchResponseSchema,
	runtimeVaultSettingsGetResponseSchema,
	runtimeVaultSettingsUpdateRequestSchema,
	runtimeVaultSettingsUpdateResponseSchema,
	runtimeVaultViewCreateRequestSchema,
	runtimeVaultViewCreateResponseSchema,
	runtimeVaultViewDeleteRequestSchema,
	runtimeVaultViewDeleteResponseSchema,
	runtimeVaultViewsListRequestSchema,
	runtimeVaultViewsListResponseSchema,
	runtimeVaultViewUpdateRequestSchema,
	runtimeVaultViewUpdateResponseSchema,
	runtimeWorkspaceAttachmentDeleteFileRequestSchema,
	runtimeWorkspaceAttachmentDeleteRequestSchema,
	runtimeWorkspaceAttachmentDeleteResponseSchema,
	runtimeWorkspaceAttachmentRequestSchema,
	runtimeWorkspaceAttachmentsListResponseSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceChangesResponseSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceFileSearchResponseSchema,
	runtimeWorkspaceStateNotifyResponseSchema,
	runtimeWorkspaceStateResponseSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeDeleteResponseSchema,
	runtimeWorktreeEnsureRequestSchema,
	runtimeWorktreeEnsureResponseSchema,
} from "../core/api-contract";
import { getGiteeAuthService } from "../gitee-auth";
import { getGitHubAuthService } from "../github-auth";
import { getResidentImGateway } from "../im/gateway/resident-gateway";
import { getImCredentialService } from "../im/im-credential-service";
import type { WorkspaceDbApi } from "./workspace-db-api";
import type { WorkspaceStorageApi } from "./workspace-storage-api";

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
	runtimeApi: {
		loadConfig: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeConfigResponse>;
		saveConfig: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeConfigSaveRequest,
		) => Promise<RuntimeConfigResponse>;
		startTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStartRequest,
		) => Promise<RuntimeTaskSessionStartResponse>;
		stopTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		sendTaskSessionInput: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionInputRequest,
		) => Promise<RuntimeTaskSessionInputResponse>;
		getTaskChatMessages: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatMessagesRequest,
		) => Promise<RuntimeTaskChatMessagesResponse>;
		getKanbanSlashCommands: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeSlashCommandsResponse>;
		sendTaskChatMessage: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatSendRequest,
		) => Promise<RuntimeTaskChatSendResponse>;
		writeTaskSessionAttachment: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionAttachmentRequest,
		) => Promise<RuntimeTaskSessionAttachmentResponse>;
		writeWorkspaceAttachment: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceAttachmentRequest,
		) => Promise<RuntimeTaskSessionAttachmentResponse>;
		deleteWorkspaceAttachmentScope: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceAttachmentDeleteRequest,
		) => Promise<RuntimeWorkspaceAttachmentDeleteResponse>;
		listWorkspaceAttachments: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceAttachmentsListResponse>;
		deleteWorkspaceAttachment: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceAttachmentDeleteFileRequest,
		) => Promise<RuntimeWorkspaceAttachmentDeleteResponse>;
		reloadTaskChatSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatReloadRequest,
		) => Promise<RuntimeTaskChatReloadResponse>;
		abortTaskChatTurn: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatAbortRequest,
		) => Promise<RuntimeTaskChatAbortResponse>;
		cancelTaskChatTurn: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatCancelRequest,
		) => Promise<RuntimeTaskChatCancelResponse>;
		listHomeThreads: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeHomeChatThreadsListResponse>;
		createHomeThread: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatThreadCreateRequest,
		) => Promise<RuntimeHomeChatThreadMutationResponse>;
		renameHomeThread: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatThreadRenameRequest,
		) => Promise<RuntimeHomeChatThreadMutationResponse>;
		setHomeThreadTitle: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatThreadSetTitleRequest,
		) => Promise<RuntimeHomeChatThreadMutationResponse>;
		setHomeThreadNextStep: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatThreadSetNextStepRequest,
		) => Promise<RuntimeHomeChatThreadMutationResponse>;
		bindHomeThreadImChannel: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatThreadBindImChannelRequest,
		) => Promise<RuntimeHomeChatThreadMutationResponse>;
		unbindHomeThreadImChannel: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatThreadImChannelIdRequest,
		) => Promise<RuntimeHomeChatThreadMutationResponse>;
		getHomeThreadImChannel: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatThreadImChannelIdRequest,
		) => Promise<RuntimeHomeChatThreadImChannelResponse>;
		closeHomeThread: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatThreadCloseRequest,
		) => Promise<RuntimeHomeChatThreadMutationResponse>;
		listImChats: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeImChatListResponse>;
		addImChat: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeImChatAddRequest,
		) => Promise<RuntimeImChatMutationResponse>;
		removeImChat: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeImChatRemoveRequest,
		) => Promise<RuntimeImChatMutationResponse>;
		setHomeFullscreenTabs: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeHomeChatFullscreenTabsSaveRequest,
		) => Promise<RuntimeHomeChatFullscreenTabsResponse>;
		getKanbanProviderCatalog: (
			scope: RuntimeTrpcWorkspaceScope | null,
		) => Promise<RuntimeKanbanProviderCatalogResponse>;
		getKanbanProviderModels: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeKanbanProviderModelsRequest,
		) => Promise<RuntimeKanbanProviderModelsResponse>;
		fetchRemoteProviderModels: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeFetchRemoteModelsRequest,
		) => Promise<RuntimeFetchRemoteModelsResponse>;
		getKanbanMcpAuthStatuses: (
			scope: RuntimeTrpcWorkspaceScope | null,
		) => Promise<RuntimeKanbanMcpAuthStatusResponse>;
		runKanbanMcpServerOAuth: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeKanbanMcpOAuthRequest,
		) => Promise<RuntimeKanbanMcpOAuthResponse>;
		getKanbanMcpSettings: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeKanbanMcpSettingsResponse>;
		saveKanbanMcpSettings: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeKanbanMcpSettingsSaveRequest,
		) => Promise<RuntimeKanbanMcpSettingsSaveResponse>;
		startShellSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeShellSessionStartRequest,
		) => Promise<RuntimeShellSessionStartResponse>;
		runCommand: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeCommandRunRequest,
		) => Promise<RuntimeCommandRunResponse>;
		resetAllState: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeDebugResetAllStateResponse>;
		openFile: (input: RuntimeOpenFileRequest) => Promise<RuntimeOpenFileResponse>;
		getUpdateStatus: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeUpdateStatusResponse>;
		runUpdateNow: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeRunUpdateResponse>;
		listAgentProviderConfigs: () => Promise<RuntimeAgentProviderConfigListResponse>;
		listAgentProviders: () => Promise<RuntimeAgentProviderSetListResponse>;
		saveAgentProviderConfig: (
			input: RuntimeAgentProviderConfigSaveRequest,
		) => Promise<RuntimeAgentProviderMutationResponse>;
		addProviderToAgent: (input: RuntimeAgentProviderMutationRequest) => Promise<RuntimeAgentProviderMutationResponse>;
		removeProviderFromAgent: (
			input: RuntimeAgentProviderMutationRequest,
		) => Promise<RuntimeAgentProviderMutationResponse>;
		selectAgentProvider: (
			input: RuntimeAgentProviderMutationRequest,
		) => Promise<RuntimeAgentProviderMutationResponse>;
		setAgentExecutablePath: (
			input: RuntimeAgentExecutablePathSaveRequest,
		) => Promise<RuntimeAgentExecutablePathResponse>;
	};
	workspaceApi: {
		loadGitSummary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitSummaryResponse>;
		runGitSyncAction: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { action: RuntimeGitSyncAction },
		) => Promise<RuntimeGitSyncResponse>;
		checkoutGitBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCheckoutRequest,
		) => Promise<RuntimeGitCheckoutResponse>;
		discardGitChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitDiscardResponse>;
		loadChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceChangesRequest,
		) => Promise<RuntimeWorkspaceChangesResponse>;
		loadArtifacts: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeArtifactsRequest,
		) => Promise<RuntimeArtifactsResponse>;
		loadArtifactContent: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeArtifactContentRequest,
		) => Promise<RuntimeArtifactContentResponse>;
		ensureWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeEnsureRequest,
		) => Promise<RuntimeWorktreeEnsureResponse>;
		deleteWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeDeleteRequest,
		) => Promise<RuntimeWorktreeDeleteResponse>;
		loadTaskContext: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest,
		) => Promise<RuntimeTaskWorkspaceInfoResponse>;
		searchFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceFileSearchRequest,
		) => Promise<RuntimeWorkspaceFileSearchResponse>;
		loadState: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateResponse>;
		listFiles: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeFilesListResponse>;
		getFile: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFileGetRequest) => Promise<RuntimeFileGetResponse>;
		addFile: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFileAddRequest) => Promise<RuntimeFileAddResponse>;
		updateFile: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFileUpdateRequest,
		) => Promise<RuntimeFileUpdateResponse>;
		deleteFile: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFileDeleteRequest,
		) => Promise<RuntimeFileDeleteResponse>;
		getFileBytes: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFileBytesRequest,
		) => Promise<RuntimeFileBytesResponse>;
		getFilePath: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFilePathRequest,
		) => Promise<RuntimeFilePathResponse>;
		listDocuments: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultDocumentsListRequest,
		) => Promise<RuntimeVaultDocumentsListResponse>;
		getDocument: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultDocumentGetRequest,
		) => Promise<RuntimeVaultDocumentGetResponse>;
		getDocumentLinks: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultDocumentLinksGetRequest,
		) => Promise<RuntimeVaultDocumentLinksGetResponse>;
		searchDocuments: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultSearchRequest,
		) => Promise<RuntimeVaultSearchResponse>;
		createDocument: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultDocumentCreateRequest,
		) => Promise<RuntimeVaultDocumentCreateResponse>;
		updateDocument: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultDocumentUpdateRequest,
		) => Promise<RuntimeVaultDocumentUpdateResponse>;
		deleteDocument: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultDocumentDeleteRequest,
		) => Promise<RuntimeVaultDocumentDeleteResponse>;
		exportDocument: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultDocumentExportRequest,
		) => Promise<RuntimeVaultDocumentExportResponse>;
		exportArchive: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultArchiveExportRequest,
		) => Promise<RuntimeVaultArchiveExportResponse>;
		listViews: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultViewsListRequest,
		) => Promise<RuntimeVaultViewsListResponse>;
		createView: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultViewCreateRequest,
		) => Promise<RuntimeVaultViewCreateResponse>;
		updateView: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultViewUpdateRequest,
		) => Promise<RuntimeVaultViewUpdateResponse>;
		deleteView: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultViewDeleteRequest,
		) => Promise<RuntimeVaultViewDeleteResponse>;
		getVaultSettings: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeVaultSettingsGetResponse>;
		getGitUserIdentity: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeGitUserIdentityResponse>;
		setGitUserIdentity: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeSetGitUserIdentityRequest,
		) => Promise<RuntimeSetGitUserIdentityResponse>;
		getGitRemote: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeGitRemoteResponse>;
		setGitRemote: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeSetGitRemoteRequest,
		) => Promise<RuntimeSetGitRemoteResponse>;
		updateVaultSettings: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeVaultSettingsUpdateRequest,
		) => Promise<RuntimeVaultSettingsUpdateResponse>;
		getBoardSyncStatus: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeBoardSyncStatusResponse>;
		runBoardSyncAction: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeBoardSyncActionRequest,
		) => Promise<RuntimeBoardSyncActionResponse>;
		setBoardAutoSync: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeBoardAutoSyncRequest,
		) => Promise<RuntimeBoardAutoSyncResponse>;
		updateBoardBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeBoardBranchUpdateRequest,
		) => Promise<RuntimeBoardBranchUpdateResponse>;
		notifyStateUpdated: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateNotifyResponse>;
		saveState: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceStateSaveRequest,
		) => Promise<RuntimeWorkspaceStateResponse>;
		loadWorkspaceChanges: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceChangesResponse>;
		loadGitLog: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeGitLogRequest) => Promise<RuntimeGitLogResponse>;
		loadGitRefs: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitRefsResponse>;
		loadCommitDiff: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitDiffRequest,
		) => Promise<RuntimeGitCommitDiffResponse>;
		createGitTag: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitTagCreateRequest,
		) => Promise<RuntimeGitTagMutationResponse>;
		deleteGitTag: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitTagDeleteRequest,
		) => Promise<RuntimeGitTagMutationResponse>;
	} & WorkspaceDbApi &
		WorkspaceStorageApi;
	workspaceFsApi: {
		listDir: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsListDirRequest) => Promise<RuntimeFsListDirResponse>;
		listPaths: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFsListPathsRequest,
		) => Promise<RuntimeFsListPathsResponse>;
		readFile: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFsReadFileRequest,
		) => Promise<RuntimeFsReadFileResponse>;
		downloadEntry: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFsDownloadEntryRequest,
		) => Promise<RuntimeFsDownloadEntryResponse>;
		writeFile: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFsWriteFileRequest,
		) => Promise<RuntimeFsWriteFileResponse>;
		uploadFile: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFsUploadFileRequest,
		) => Promise<RuntimeFsUploadFileResponse>;
		stat: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsStatRequest) => Promise<RuntimeFsStatResponse>;
		createEntry: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFsCreateEntryRequest,
		) => Promise<RuntimeFsEntryMutationResponse>;
		rename: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFsRenameRequest,
		) => Promise<RuntimeFsEntryMutationResponse>;
		move: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsMoveRequest) => Promise<RuntimeFsEntryMutationResponse>;
		deleteEntry: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFsDeleteEntryRequest,
		) => Promise<RuntimeFsDeleteEntryResponse>;
	};
	dbApi: {
		listConnections: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeDbConnectionListResponse>;
		addConnection: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDbConnectionAddRequest,
		) => Promise<RuntimeDbConnectionAddResponse>;
		removeConnection: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDbConnectionRemoveRequest,
		) => Promise<RuntimeDbConnectionRemoveResponse>;
		testConnection: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDbConnectionTestRequest,
		) => Promise<RuntimeDbConnectionTestResponse>;
		listTables: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeDbTablesRequest) => Promise<RuntimeDbTablesResponse>;
		describeTable: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDbDescribeRequest,
		) => Promise<RuntimeDbDescribeResponse>;
		runQuery: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeDbQueryRequest) => Promise<RuntimeDbQueryResponse>;
		browseTable: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDbBrowseRequest,
		) => Promise<RuntimeDbBrowseResponse>;
	};
	projectsApi: {
		listProjects: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectsResponse>;
		addProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectAddRequest,
		) => Promise<RuntimeProjectAddResponse>;
		removeProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectRemoveRequest,
		) => Promise<RuntimeProjectRemoveResponse>;
		pickProjectDirectory: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectDirectoryPickerResponse>;
		listDirectoryContents: (
			preferredWorkspaceId: string | null,
			input: RuntimeDirectoryListRequest,
		) => Promise<RuntimeDirectoryListResponse>;
	};
	hooksApi: {
		ingest: (input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	};
}

interface RuntimeTrpcContextWithWorkspaceScope extends RuntimeTrpcContext {
	workspaceScope: RuntimeTrpcWorkspaceScope;
}

function readConflictRevision(cause: unknown): number | null {
	if (!cause || typeof cause !== "object" || !("currentRevision" in cause)) {
		return null;
	}
	const revision = (cause as { currentRevision?: unknown }).currentRevision;
	if (typeof revision !== "number") {
		return null;
	}
	return Number.isFinite(revision) ? revision : null;
}

const t = initTRPC.context<RuntimeTrpcContext>().create({
	errorFormatter({ shape, error }) {
		const conflictRevision = error.code === "CONFLICT" ? readConflictRevision(error.cause) : null;
		return {
			...shape,
			data: {
				...shape.data,
				conflictRevision,
			},
		};
	},
});

const workspaceProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.requestedWorkspaceId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Missing workspace scope. Include x-kanban-workspace-id header or workspaceId query parameter.",
		});
	}
	if (!ctx.workspaceScope) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Unknown workspace ID: ${ctx.requestedWorkspaceId}`,
		});
	}
	return next({
		ctx: {
			...ctx,
			workspaceScope: ctx.workspaceScope,
		} satisfies RuntimeTrpcContextWithWorkspaceScope,
	});
});

const optionalTaskWorkspaceInfoRequestSchema = runtimeTaskWorkspaceInfoRequestSchema.nullable().optional();
const gitSyncActionInputSchema = z.object({
	action: runtimeGitSyncActionSchema,
});

export const runtimeAppRouter = t.router({
	runtime: t.router({
		getConfig: t.procedure.output(runtimeConfigResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.loadConfig(ctx.workspaceScope);
		}),
		saveConfig: t.procedure
			.input(runtimeConfigSaveRequestSchema)
			.output(runtimeConfigResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveConfig(ctx.workspaceScope, input);
			}),
		startTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStartRequestSchema)
			.output(runtimeTaskSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startTaskSession(ctx.workspaceScope, input);
			}),
		stopTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStopRequestSchema)
			.output(runtimeTaskSessionStopResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.stopTaskSession(ctx.workspaceScope, input);
			}),
		sendTaskSessionInput: workspaceProcedure
			.input(runtimeTaskSessionInputRequestSchema)
			.output(runtimeTaskSessionInputResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.sendTaskSessionInput(ctx.workspaceScope, input);
			}),
		getTaskChatMessages: workspaceProcedure
			.input(runtimeTaskChatMessagesRequestSchema)
			.output(runtimeTaskChatMessagesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskChatMessages(ctx.workspaceScope, input);
			}),
		getKanbanSlashCommands: t.procedure.output(runtimeSlashCommandsResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getKanbanSlashCommands(ctx.workspaceScope);
		}),
		reloadTaskChatSession: workspaceProcedure
			.input(runtimeTaskChatReloadRequestSchema)
			.output(runtimeTaskChatReloadResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.reloadTaskChatSession(ctx.workspaceScope, input);
			}),
		sendTaskChatMessage: workspaceProcedure
			.input(runtimeTaskChatSendRequestSchema)
			.output(runtimeTaskChatSendResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.sendTaskChatMessage(ctx.workspaceScope, input);
			}),
		writeTaskSessionAttachment: workspaceProcedure
			.input(runtimeTaskSessionAttachmentRequestSchema)
			.output(runtimeTaskSessionAttachmentResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.writeTaskSessionAttachment(ctx.workspaceScope, input);
			}),
		writeWorkspaceAttachment: workspaceProcedure
			.input(runtimeWorkspaceAttachmentRequestSchema)
			.output(runtimeTaskSessionAttachmentResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.writeWorkspaceAttachment(ctx.workspaceScope, input);
			}),
		deleteWorkspaceAttachmentScope: workspaceProcedure
			.input(runtimeWorkspaceAttachmentDeleteRequestSchema)
			.output(runtimeWorkspaceAttachmentDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.deleteWorkspaceAttachmentScope(ctx.workspaceScope, input);
			}),
		listWorkspaceAttachments: workspaceProcedure
			.output(runtimeWorkspaceAttachmentsListResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.listWorkspaceAttachments(ctx.workspaceScope);
			}),
		deleteWorkspaceAttachment: workspaceProcedure
			.input(runtimeWorkspaceAttachmentDeleteFileRequestSchema)
			.output(runtimeWorkspaceAttachmentDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.deleteWorkspaceAttachment(ctx.workspaceScope, input);
			}),
		abortTaskChatTurn: workspaceProcedure
			.input(runtimeTaskChatAbortRequestSchema)
			.output(runtimeTaskChatAbortResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.abortTaskChatTurn(ctx.workspaceScope, input);
			}),
		cancelTaskChatTurn: workspaceProcedure
			.input(runtimeTaskChatCancelRequestSchema)
			.output(runtimeTaskChatCancelResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.cancelTaskChatTurn(ctx.workspaceScope, input);
			}),
		listHomeThreads: workspaceProcedure.output(runtimeHomeChatThreadsListResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.listHomeThreads(ctx.workspaceScope);
		}),
		createHomeThread: workspaceProcedure
			.input(runtimeHomeChatThreadCreateRequestSchema)
			.output(runtimeHomeChatThreadMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.createHomeThread(ctx.workspaceScope, input);
			}),
		renameHomeThread: workspaceProcedure
			.input(runtimeHomeChatThreadRenameRequestSchema)
			.output(runtimeHomeChatThreadMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.renameHomeThread(ctx.workspaceScope, input);
			}),
		setHomeThreadTitle: workspaceProcedure
			.input(runtimeHomeChatThreadSetTitleRequestSchema)
			.output(runtimeHomeChatThreadMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.setHomeThreadTitle(ctx.workspaceScope, input);
			}),
		setHomeThreadNextStep: workspaceProcedure
			.input(runtimeHomeChatThreadSetNextStepRequestSchema)
			.output(runtimeHomeChatThreadMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.setHomeThreadNextStep(ctx.workspaceScope, input);
			}),
		bindHomeThreadImChannel: workspaceProcedure
			.input(runtimeHomeChatThreadBindImChannelRequestSchema)
			.output(runtimeHomeChatThreadMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.bindHomeThreadImChannel(ctx.workspaceScope, input);
			}),
		unbindHomeThreadImChannel: workspaceProcedure
			.input(runtimeHomeChatThreadImChannelIdRequestSchema)
			.output(runtimeHomeChatThreadMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.unbindHomeThreadImChannel(ctx.workspaceScope, input);
			}),
		getHomeThreadImChannel: workspaceProcedure
			.input(runtimeHomeChatThreadImChannelIdRequestSchema)
			.output(runtimeHomeChatThreadImChannelResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getHomeThreadImChannel(ctx.workspaceScope, input);
			}),
		closeHomeThread: workspaceProcedure
			.input(runtimeHomeChatThreadCloseRequestSchema)
			.output(runtimeHomeChatThreadMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.closeHomeThread(ctx.workspaceScope, input);
			}),
		// Bindable IM chat list (requirement ac99c) — the palette a home thread's `imChannel`
		// can point at. Populated by manual add and by inbound auto-record (chats that @'d the bot).
		listImChats: workspaceProcedure.output(runtimeImChatListResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.listImChats(ctx.workspaceScope);
		}),
		addImChat: workspaceProcedure
			.input(runtimeImChatAddRequestSchema)
			.output(runtimeImChatMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.addImChat(ctx.workspaceScope, input);
			}),
		removeImChat: workspaceProcedure
			.input(runtimeImChatRemoveRequestSchema)
			.output(runtimeImChatMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.removeImChat(ctx.workspaceScope, input);
			}),
		setHomeFullscreenTabs: workspaceProcedure
			.input(runtimeHomeChatFullscreenTabsSaveRequestSchema)
			.output(runtimeHomeChatFullscreenTabsResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.setHomeFullscreenTabs(ctx.workspaceScope, input);
			}),
		getKanbanProviderCatalog: t.procedure
			.output(runtimeKanbanProviderCatalogResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getKanbanProviderCatalog(ctx.workspaceScope);
			}),
		getKanbanProviderModels: t.procedure
			.input(runtimeKanbanProviderModelsRequestSchema)
			.output(runtimeKanbanProviderModelsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getKanbanProviderModels(ctx.workspaceScope, input);
			}),
		fetchRemoteProviderModels: t.procedure
			.input(runtimeFetchRemoteModelsRequestSchema)
			.output(runtimeFetchRemoteModelsResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.fetchRemoteProviderModels(ctx.workspaceScope, input);
			}),
		getKanbanMcpAuthStatuses: t.procedure.output(runtimeKanbanMcpAuthStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getKanbanMcpAuthStatuses(ctx.workspaceScope);
		}),
		runKanbanMcpServerOAuth: t.procedure
			.input(runtimeKanbanMcpOAuthRequestSchema)
			.output(runtimeKanbanMcpOAuthResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runKanbanMcpServerOAuth(ctx.workspaceScope, input);
			}),
		getKanbanMcpSettings: t.procedure.output(runtimeKanbanMcpSettingsResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getKanbanMcpSettings(ctx.workspaceScope);
		}),
		saveKanbanMcpSettings: t.procedure
			.input(runtimeKanbanMcpSettingsSaveRequestSchema)
			.output(runtimeKanbanMcpSettingsSaveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveKanbanMcpSettings(ctx.workspaceScope, input);
			}),
		startShellSession: workspaceProcedure
			.input(runtimeShellSessionStartRequestSchema)
			.output(runtimeShellSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startShellSession(ctx.workspaceScope, input);
			}),
		runCommand: workspaceProcedure
			.input(runtimeCommandRunRequestSchema)
			.output(runtimeCommandRunResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runCommand(ctx.workspaceScope, input);
			}),
		resetAllState: t.procedure.output(runtimeDebugResetAllStateResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.resetAllState(ctx.workspaceScope);
		}),
		openFile: t.procedure
			.input(runtimeOpenFileRequestSchema)
			.output(runtimeOpenFileResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.openFile(input);
			}),
		getUpdateStatus: t.procedure.output(runtimeUpdateStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getUpdateStatus(ctx.workspaceScope);
		}),
		runUpdateNow: t.procedure.output(runtimeRunUpdateResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.runUpdateNow(ctx.workspaceScope);
		}),
		listAgentProviderConfigs: t.procedure
			.output(runtimeAgentProviderConfigListResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.listAgentProviderConfigs();
			}),
		listAgentProviders: t.procedure.output(runtimeAgentProviderSetListResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.listAgentProviders();
		}),
		saveAgentProviderConfig: t.procedure
			.input(runtimeAgentProviderConfigSaveRequestSchema)
			.output(runtimeAgentProviderMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveAgentProviderConfig(input);
			}),
		addProviderToAgent: t.procedure
			.input(runtimeAgentProviderMutationRequestSchema)
			.output(runtimeAgentProviderMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.addProviderToAgent(input);
			}),
		removeProviderFromAgent: t.procedure
			.input(runtimeAgentProviderMutationRequestSchema)
			.output(runtimeAgentProviderMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.removeProviderFromAgent(input);
			}),
		selectAgentProvider: t.procedure
			.input(runtimeAgentProviderMutationRequestSchema)
			.output(runtimeAgentProviderMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.selectAgentProvider(input);
			}),
		setAgentExecutablePath: t.procedure
			.input(runtimeAgentExecutablePathSaveRequestSchema)
			.output(runtimeAgentExecutablePathResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.setAgentExecutablePath(input);
			}),
	}),
	workspace: t.router({
		getGitSummary: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitSummaryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitSummary(ctx.workspaceScope, input ?? null);
			}),
		runGitSyncAction: workspaceProcedure
			.input(gitSyncActionInputSchema)
			.output(runtimeGitSyncResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.runGitSyncAction(ctx.workspaceScope, input);
			}),
		checkoutGitBranch: workspaceProcedure
			.input(runtimeGitCheckoutRequestSchema)
			.output(runtimeGitCheckoutResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.checkoutGitBranch(ctx.workspaceScope, input);
			}),
		discardGitChanges: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitDiscardResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.discardGitChanges(ctx.workspaceScope, input ?? null);
			}),
		getChanges: workspaceProcedure
			.input(runtimeWorkspaceChangesRequestSchema)
			.output(runtimeWorkspaceChangesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadChanges(ctx.workspaceScope, input);
			}),
		getArtifacts: workspaceProcedure
			.input(runtimeArtifactsRequestSchema)
			.output(runtimeArtifactsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadArtifacts(ctx.workspaceScope, input);
			}),
		getArtifactContent: workspaceProcedure
			.input(runtimeArtifactContentRequestSchema)
			.output(runtimeArtifactContentResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadArtifactContent(ctx.workspaceScope, input);
			}),
		ensureWorktree: workspaceProcedure
			.input(runtimeWorktreeEnsureRequestSchema)
			.output(runtimeWorktreeEnsureResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.ensureWorktree(ctx.workspaceScope, input);
			}),
		deleteWorktree: workspaceProcedure
			.input(runtimeWorktreeDeleteRequestSchema)
			.output(runtimeWorktreeDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteWorktree(ctx.workspaceScope, input);
			}),
		getTaskContext: workspaceProcedure
			.input(runtimeTaskWorkspaceInfoRequestSchema)
			.output(runtimeTaskWorkspaceInfoResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadTaskContext(ctx.workspaceScope, input);
			}),
		searchFiles: workspaceProcedure
			.input(runtimeWorkspaceFileSearchRequestSchema)
			.output(runtimeWorkspaceFileSearchResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.searchFiles(ctx.workspaceScope, input);
			}),
		getState: workspaceProcedure.output(runtimeWorkspaceStateResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadState(ctx.workspaceScope);
		}),
		listFiles: workspaceProcedure.output(runtimeFilesListResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.listFiles(ctx.workspaceScope);
		}),
		getFile: workspaceProcedure
			.input(runtimeFileGetRequestSchema)
			.output(runtimeFileGetResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.getFile(ctx.workspaceScope, input);
			}),
		getFileBytes: workspaceProcedure
			.input(runtimeFileBytesRequestSchema)
			.output(runtimeFileBytesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.getFileBytes(ctx.workspaceScope, input);
			}),
		getFilePath: workspaceProcedure
			.input(runtimeFilePathRequestSchema)
			.output(runtimeFilePathResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.getFilePath(ctx.workspaceScope, input);
			}),
		addFile: workspaceProcedure
			.input(runtimeFileAddRequestSchema)
			.output(runtimeFileAddResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.addFile(ctx.workspaceScope, input);
			}),
		updateFile: workspaceProcedure
			.input(runtimeFileUpdateRequestSchema)
			.output(runtimeFileUpdateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.updateFile(ctx.workspaceScope, input);
			}),
		deleteFile: workspaceProcedure
			.input(runtimeFileDeleteRequestSchema)
			.output(runtimeFileDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteFile(ctx.workspaceScope, input);
			}),
		listDocuments: workspaceProcedure
			.input(runtimeVaultDocumentsListRequestSchema)
			.output(runtimeVaultDocumentsListResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.listDocuments(ctx.workspaceScope, input);
			}),
		getDocument: workspaceProcedure
			.input(runtimeVaultDocumentGetRequestSchema)
			.output(runtimeVaultDocumentGetResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.getDocument(ctx.workspaceScope, input);
			}),
		getDocumentLinks: workspaceProcedure
			.input(runtimeVaultDocumentLinksGetRequestSchema)
			.output(runtimeVaultDocumentLinksGetResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.getDocumentLinks(ctx.workspaceScope, input);
			}),
		searchDocuments: workspaceProcedure
			.input(runtimeVaultSearchRequestSchema)
			.output(runtimeVaultSearchResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.searchDocuments(ctx.workspaceScope, input);
			}),
		createDocument: workspaceProcedure
			.input(runtimeVaultDocumentCreateRequestSchema)
			.output(runtimeVaultDocumentCreateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.createDocument(ctx.workspaceScope, input);
			}),
		updateDocument: workspaceProcedure
			.input(runtimeVaultDocumentUpdateRequestSchema)
			.output(runtimeVaultDocumentUpdateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.updateDocument(ctx.workspaceScope, input);
			}),
		deleteDocument: workspaceProcedure
			.input(runtimeVaultDocumentDeleteRequestSchema)
			.output(runtimeVaultDocumentDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteDocument(ctx.workspaceScope, input);
			}),
		exportDocument: workspaceProcedure
			.input(runtimeVaultDocumentExportRequestSchema)
			.output(runtimeVaultDocumentExportResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.exportDocument(ctx.workspaceScope, input);
			}),
		exportArchive: workspaceProcedure
			.input(runtimeVaultArchiveExportRequestSchema)
			.output(runtimeVaultArchiveExportResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.exportArchive(ctx.workspaceScope, input);
			}),
		listViews: workspaceProcedure
			.input(runtimeVaultViewsListRequestSchema)
			.output(runtimeVaultViewsListResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.listViews(ctx.workspaceScope, input);
			}),
		createView: workspaceProcedure
			.input(runtimeVaultViewCreateRequestSchema)
			.output(runtimeVaultViewCreateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.createView(ctx.workspaceScope, input);
			}),
		updateView: workspaceProcedure
			.input(runtimeVaultViewUpdateRequestSchema)
			.output(runtimeVaultViewUpdateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.updateView(ctx.workspaceScope, input);
			}),
		deleteView: workspaceProcedure
			.input(runtimeVaultViewDeleteRequestSchema)
			.output(runtimeVaultViewDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteView(ctx.workspaceScope, input);
			}),
		getVaultSettings: workspaceProcedure.output(runtimeVaultSettingsGetResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.getVaultSettings(ctx.workspaceScope);
		}),
		getGitUserIdentity: workspaceProcedure.output(runtimeGitUserIdentityResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.getGitUserIdentity(ctx.workspaceScope);
		}),
		setGitUserIdentity: workspaceProcedure
			.input(runtimeSetGitUserIdentityRequestSchema)
			.output(runtimeSetGitUserIdentityResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.setGitUserIdentity(ctx.workspaceScope, input);
			}),
		getGitRemote: workspaceProcedure.output(runtimeGitRemoteResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.getGitRemote(ctx.workspaceScope);
		}),
		setGitRemote: workspaceProcedure
			.input(runtimeSetGitRemoteRequestSchema)
			.output(runtimeSetGitRemoteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.setGitRemote(ctx.workspaceScope, input);
			}),
		updateVaultSettings: workspaceProcedure
			.input(runtimeVaultSettingsUpdateRequestSchema)
			.output(runtimeVaultSettingsUpdateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.updateVaultSettings(ctx.workspaceScope, input);
			}),
		getBoardSyncStatus: workspaceProcedure.output(runtimeBoardSyncStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.getBoardSyncStatus(ctx.workspaceScope);
		}),
		runBoardSyncAction: workspaceProcedure
			.input(runtimeBoardSyncActionRequestSchema)
			.output(runtimeBoardSyncActionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.runBoardSyncAction(ctx.workspaceScope, input);
			}),
		setBoardAutoSync: workspaceProcedure
			.input(runtimeBoardAutoSyncRequestSchema)
			.output(runtimeBoardAutoSyncResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.setBoardAutoSync(ctx.workspaceScope, input);
			}),
		updateBoardBranch: workspaceProcedure
			.input(runtimeBoardBranchUpdateRequestSchema)
			.output(runtimeBoardBranchUpdateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.updateBoardBranch(ctx.workspaceScope, input);
			}),
		notifyStateUpdated: workspaceProcedure
			.output(runtimeWorkspaceStateNotifyResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.workspaceApi.notifyStateUpdated(ctx.workspaceScope);
			}),
		saveState: workspaceProcedure
			.input(runtimeWorkspaceStateSaveRequestSchema)
			.output(runtimeWorkspaceStateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.saveState(ctx.workspaceScope, input);
			}),
		getWorkspaceChanges: workspaceProcedure.output(runtimeWorkspaceChangesResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadWorkspaceChanges(ctx.workspaceScope);
		}),
		getGitLog: workspaceProcedure
			.input(runtimeGitLogRequestSchema)
			.output(runtimeGitLogResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitLog(ctx.workspaceScope, input);
			}),
		getGitRefs: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitRefsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitRefs(ctx.workspaceScope, input ?? null);
			}),
		getCommitDiff: workspaceProcedure
			.input(runtimeGitCommitDiffRequestSchema)
			.output(runtimeGitCommitDiffResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadCommitDiff(ctx.workspaceScope, input);
			}),
		createGitTag: workspaceProcedure
			.input(runtimeGitTagCreateRequestSchema)
			.output(runtimeGitTagMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.createGitTag(ctx.workspaceScope, input);
			}),
		deleteGitTag: workspaceProcedure
			.input(runtimeGitTagDeleteRequestSchema)
			.output(runtimeGitTagMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteGitTag(ctx.workspaceScope, input);
			}),
	}),
	workspaceFs: t.router({
		listDir: workspaceProcedure
			.input(runtimeFsListDirRequestSchema)
			.output(runtimeFsListDirResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.listDir(ctx.workspaceScope, input);
			}),
		listPaths: workspaceProcedure
			.input(runtimeFsListPathsRequestSchema)
			.output(runtimeFsListPathsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.listPaths(ctx.workspaceScope, input);
			}),
		readFile: workspaceProcedure
			.input(runtimeFsReadFileRequestSchema)
			.output(runtimeFsReadFileResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.readFile(ctx.workspaceScope, input);
			}),
		downloadEntry: workspaceProcedure
			.input(runtimeFsDownloadEntryRequestSchema)
			.output(runtimeFsDownloadEntryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.downloadEntry(ctx.workspaceScope, input);
			}),
		writeFile: workspaceProcedure
			.input(runtimeFsWriteFileRequestSchema)
			.output(runtimeFsWriteFileResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.writeFile(ctx.workspaceScope, input);
			}),
		uploadFile: workspaceProcedure
			.input(runtimeFsUploadFileRequestSchema)
			.output(runtimeFsUploadFileResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.uploadFile(ctx.workspaceScope, input);
			}),
		stat: workspaceProcedure
			.input(runtimeFsStatRequestSchema)
			.output(runtimeFsStatResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.stat(ctx.workspaceScope, input);
			}),
		createEntry: workspaceProcedure
			.input(runtimeFsCreateEntryRequestSchema)
			.output(runtimeFsEntryMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.createEntry(ctx.workspaceScope, input);
			}),
		rename: workspaceProcedure
			.input(runtimeFsRenameRequestSchema)
			.output(runtimeFsEntryMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.rename(ctx.workspaceScope, input);
			}),
		move: workspaceProcedure
			.input(runtimeFsMoveRequestSchema)
			.output(runtimeFsEntryMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.move(ctx.workspaceScope, input);
			}),
		deleteEntry: workspaceProcedure
			.input(runtimeFsDeleteEntryRequestSchema)
			.output(runtimeFsDeleteEntryResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceFsApi.deleteEntry(ctx.workspaceScope, input);
			}),
	}),
	db: t.router({
		connection: t.router({
			list: workspaceProcedure.output(runtimeDbConnectionListResponseSchema).query(async ({ ctx }) => {
				return await ctx.dbApi.listConnections(ctx.workspaceScope);
			}),
			add: workspaceProcedure
				.input(runtimeDbConnectionAddRequestSchema)
				.output(runtimeDbConnectionAddResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.dbApi.addConnection(ctx.workspaceScope, input);
				}),
			remove: workspaceProcedure
				.input(runtimeDbConnectionRemoveRequestSchema)
				.output(runtimeDbConnectionRemoveResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.dbApi.removeConnection(ctx.workspaceScope, input);
				}),
			test: workspaceProcedure
				.input(runtimeDbConnectionTestRequestSchema)
				.output(runtimeDbConnectionTestResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.dbApi.testConnection(ctx.workspaceScope, input);
				}),
		}),
		tables: workspaceProcedure
			.input(runtimeDbTablesRequestSchema)
			.output(runtimeDbTablesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.dbApi.listTables(ctx.workspaceScope, input);
			}),
		describe: workspaceProcedure
			.input(runtimeDbDescribeRequestSchema)
			.output(runtimeDbDescribeResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.dbApi.describeTable(ctx.workspaceScope, input);
			}),
		query: workspaceProcedure
			.input(runtimeDbQueryRequestSchema)
			.output(runtimeDbQueryResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.dbApi.runQuery(ctx.workspaceScope, input);
			}),
		browse: workspaceProcedure
			.input(runtimeDbBrowseRequestSchema)
			.output(runtimeDbBrowseResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.dbApi.browseTable(ctx.workspaceScope, input);
			}),
	}),
	projects: t.router({
		list: t.procedure.output(runtimeProjectsResponseSchema).query(async ({ ctx }) => {
			return await ctx.projectsApi.listProjects(ctx.requestedWorkspaceId);
		}),
		add: t.procedure
			.input(runtimeProjectAddRequestSchema)
			.output(runtimeProjectAddResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input);
			}),
		remove: t.procedure
			.input(runtimeProjectRemoveRequestSchema)
			.output(runtimeProjectRemoveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.removeProject(ctx.requestedWorkspaceId, input);
			}),
		pickDirectory: t.procedure.output(runtimeProjectDirectoryPickerResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.projectsApi.pickProjectDirectory(ctx.requestedWorkspaceId);
		}),
		listDirectoryContents: t.procedure
			.input(runtimeDirectoryListRequestSchema)
			.output(runtimeDirectoryListResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.projectsApi.listDirectoryContents(ctx.requestedWorkspaceId, input);
			}),
	}),
	hooks: t.router({
		ingest: t.procedure
			.input(runtimeHookIngestRequestSchema)
			.output(runtimeHookIngestResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.hooksApi.ingest(input);
			}),
	}),
	database: t.router({
		listConnections: workspaceProcedure.output(runtimeDbConnectionsListResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.listConnections(ctx.workspaceScope);
		}),
		upsertConnection: workspaceProcedure
			.input(runtimeDbUpsertConnectionRequestSchema)
			.output(runtimeDbUpsertConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.upsertConnection(ctx.workspaceScope, input);
			}),
		deleteConnection: workspaceProcedure
			.input(runtimeDbDeleteConnectionRequestSchema)
			.output(runtimeDbDeleteConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteConnection(ctx.workspaceScope, input);
			}),
		testConnection: workspaceProcedure
			.input(runtimeDbTestConnectionRequestSchema)
			.output(runtimeDbTestConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.testConnection(ctx.workspaceScope, input);
			}),
		introspect: workspaceProcedure
			.input(runtimeDbIntrospectRequestSchema)
			.output(runtimeDbIntrospectResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.introspect(ctx.workspaceScope, input);
			}),
		browseTable: workspaceProcedure
			.input(runtimeDbBrowseTableRequestSchema)
			.output(runtimeDbBrowseTableResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.browseTable(ctx.workspaceScope, input);
			}),
		updateRow: workspaceProcedure
			.input(runtimeDbUpdateRowRequestSchema)
			.output(runtimeDbWriteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.updateRow(ctx.workspaceScope, input);
			}),
		insertRow: workspaceProcedure
			.input(runtimeDbInsertRowRequestSchema)
			.output(runtimeDbWriteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.insertRow(ctx.workspaceScope, input);
			}),
		deleteRow: workspaceProcedure
			.input(runtimeDbDeleteRowRequestSchema)
			.output(runtimeDbWriteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteRow(ctx.workspaceScope, input);
			}),
		previewWrite: workspaceProcedure
			.input(runtimeDbPreviewWriteRequestSchema)
			.output(runtimeDbPreviewWriteResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.previewWrite(ctx.workspaceScope, input);
			}),
	}),
	storage: t.router({
		listConnections: workspaceProcedure.output(runtimeStorageConnectionsListResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.listStorageConnections(ctx.workspaceScope);
		}),
		upsertConnection: workspaceProcedure
			.input(runtimeStorageUpsertConnectionRequestSchema)
			.output(runtimeStorageUpsertConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.upsertStorageConnection(ctx.workspaceScope, input);
			}),
		deleteConnection: workspaceProcedure
			.input(runtimeStorageDeleteConnectionRequestSchema)
			.output(runtimeStorageDeleteConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteStorageConnection(ctx.workspaceScope, input);
			}),
		testConnection: workspaceProcedure
			.input(runtimeStorageTestConnectionRequestSchema)
			.output(runtimeStorageTestConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.testStorageConnection(ctx.workspaceScope, input);
			}),
		listObjects: workspaceProcedure
			.input(runtimeStorageListRequestSchema)
			.output(runtimeStorageListResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.listObjects(ctx.workspaceScope, input);
			}),
		readObject: workspaceProcedure
			.input(runtimeStorageReadRequestSchema)
			.output(runtimeStorageObjectContentSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.readObject(ctx.workspaceScope, input);
			}),
		statObject: workspaceProcedure
			.input(runtimeStorageStatRequestSchema)
			.output(runtimeStorageStatResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.statObject(ctx.workspaceScope, input);
			}),
		downloadObject: workspaceProcedure
			.input(runtimeStorageDownloadRequestSchema)
			.output(runtimeStorageDownloadResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.downloadObject(ctx.workspaceScope, input);
			}),
	}),
	// GitHub OAuth for git remote auth. Machine-global (no workspace scope) — it delegates
	// directly to the process-wide singleton rather than through ctx. The token is never
	// returned over the wire; only the secret-free status + device-flow handshake are.
	github: t.router({
		status: t.procedure.output(runtimeGithubAuthStatusSchema).query(async () => {
			return await getGitHubAuthService().getStatus();
		}),
		beginLogin: t.procedure.output(runtimeGithubBeginLoginResponseSchema).mutation(async () => {
			return await getGitHubAuthService().beginLogin();
		}),
		// The in-flight login a UI resumes after a refresh; the `deviceCode` stays server-side.
		pendingLogin: t.procedure.output(runtimeGithubPendingLoginResponseSchema).query(async () => {
			return { pending: await getGitHubAuthService().getPendingLogin() };
		}),
		pollLogin: t.procedure.output(runtimeGithubPollLoginResponseSchema).mutation(async () => {
			return await getGitHubAuthService().pollLogin();
		}),
		cancelLogin: t.procedure.mutation(async () => {
			await getGitHubAuthService().cancelLogin();
		}),
		logout: t.procedure.output(runtimeGithubLogoutResponseSchema).mutation(async () => {
			await getGitHubAuthService().logout();
			return { status: await getGitHubAuthService().getStatus() };
		}),
	}),
	// Gitee PAT for git remote auth. Machine-global (no workspace scope) — delegates directly to
	// the process-wide singleton. The PAT is never returned over the wire; only the secret-free
	// status is. Gitee has no device flow (cf0d6), so this is status/setToken/logout only.
	gitee: t.router({
		status: t.procedure.output(runtimeGiteeAuthStatusSchema).query(async () => {
			return await getGiteeAuthService().getStatus();
		}),
		setToken: t.procedure
			.input(runtimeGiteeSetTokenRequestSchema)
			.output(runtimeGiteeSetTokenResponseSchema)
			.mutation(async ({ input }) => {
				const status = await getGiteeAuthService().login({ token: input.token, username: input.username });
				return { status };
			}),
		logout: t.procedure.output(runtimeGiteeLogoutResponseSchema).mutation(async () => {
			await getGiteeAuthService().logout();
			return { status: await getGiteeAuthService().getStatus() };
		}),
	}),
	// IM outbound-channel credentials (requirement ac99c, 阶段2). Machine-global (no workspace
	// scope) — delegates directly to the process-wide singleton. The credential VALUES (bot
	// tokens / webhook URLs / signing secrets) are NEVER returned over the wire; only the
	// secret-free per-platform status crosses it.
	im: t.router({
		status: t.procedure.output(runtimeImCredentialStatusResponseSchema).query(async () => {
			return { platforms: await getImCredentialService().getStatus() };
		}),
		setCredentials: t.procedure
			.input(runtimeImSetCredentialsRequestSchema)
			.output(runtimeImSetCredentialsResponseSchema)
			.mutation(async ({ input }) => {
				const platforms = await getImCredentialService().setCredential(input.platform, input.credential);
				// A credential can be configured (or changed) long after startup, so the resident
				// gateway must re-evaluate its connections now — otherwise the new platform's long
				// connection would only come up on the next restart. Fire-and-forget: refresh never
				// rejects, and the save response shouldn't block on a network handshake.
				void getResidentImGateway()?.refresh();
				return { status: { platforms } };
			}),
		clearCredentials: t.procedure
			.input(runtimeImClearCredentialsRequestSchema)
			.output(runtimeImClearCredentialsResponseSchema)
			.mutation(async ({ input }) => {
				const platforms = await getImCredentialService().clearCredential(input.platform);
				// Tear down the now-credential-less platform's live connection without a restart.
				void getResidentImGateway()?.refresh();
				return { status: { platforms } };
			}),
	}),
});

export type RuntimeAppRouter = typeof runtimeAppRouter;
export type RuntimeAppRouterInputs = inferRouterInputs<RuntimeAppRouter>;
export type RuntimeAppRouterOutputs = inferRouterOutputs<RuntimeAppRouter>;
