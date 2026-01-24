import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";

interface SuspendSessionRequest {
    by?: string;
    reason?: string;
}

interface SuspendSessionResponse {
    success: boolean;
    message: string;
}

export function registerSuspendSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    suspendThisHappy: (payload: SuspendSessionRequest) => Promise<void>
) {
    rpcHandlerManager.registerHandler<SuspendSessionRequest, SuspendSessionResponse>('suspendSession', async (payload) => {
        logger.debug('Suspend session request received', payload);

        void suspendThisHappy(payload ?? {});

        return {
            success: true,
            message: 'Suspending hapi CLI process'
        };
    });
}

