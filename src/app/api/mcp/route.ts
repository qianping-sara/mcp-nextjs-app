import { NextRequest, NextResponse } from 'next/server';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
// 使用正确的路径别名
import mcpServer from '@/lib/server';
import redis from '@/lib/redis';

// 重要提示：在 Serverless 环境中，此内存映射仅在单个函数实例的生命周期内有效。
// 如果 GET 和 POST 请求命中不同的实例，会话将无法找到。
const activeTransports: { [sessionId: string]: SSEServerTransport } = {};

// Redis 中 Session ID 的过期时间（秒），例如 1 小时
const SESSION_EXPIRATION_SECONDS = 3600;

/**
 * 处理 MCP 客户端的 SSE 连接请求 (GET)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function GET(_req: NextRequest) {
    console.log('Received GET request for MCP SSE connection');

    // 创建一个 ReadableStream 和对应的 writer
    const stream = new ReadableStream({
        start(controller) {
            // 创建 SSEServerTransport
            // postPath 指向我们自己，因为 POST 请求也发到 /api/mcp
            const transport = new SSEServerTransport('/api/mcp', {
                // Use @ts-expect-error as recommended by ESLint
                // @ts-expect-error - Bypassing type mismatch between SSEServerTransport expectation and ReadableStreamController
                write: (chunk) => {
                    try {
                        controller.enqueue(Buffer.from(chunk)); // 确保编码正确
                    } catch (e) {
                        console.error(`Error enqueueing SSE chunk for session ${transport.sessionId}:`, e);
                        try { controller.close(); } catch {} // 出错时尝试关闭
                    }
                },
                // Use @ts-expect-error as recommended by ESLint
                // @ts-expect-error - Bypassing type mismatch between SSEServerTransport expectation and ReadableStreamController
                end: () => {
                    console.log(`SSE stream ending for session ${transport.sessionId}`);
                    try { controller.close(); } catch {} // 确保流关闭
                },
                // 提供 close 事件处理（模拟 Response 的 close）
                onClose: () => {
                    console.log(`SSE connection closed for session ${transport.sessionId}. Cleaning up.`);
                    delete activeTransports[transport.sessionId];
                    redis.del(`mcp_session:${transport.sessionId}`).catch(err => {
                        console.error(`Error deleting session ${transport.sessionId} from Redis:`, err);
                    });
                }
            });

            const sessionId = transport.sessionId;
            console.log(`Generated Session ID: ${sessionId}`);
            activeTransports[sessionId] = transport;

            // 将 Session ID 存入 Redis 以便 POST 时验证
            redis.set(`mcp_session:${sessionId}`, 'active', 'EX', SESSION_EXPIRATION_SECONDS)
                .then(() => console.log(`Session ${sessionId} stored in Redis`))
                .catch(err => console.error(`Error storing session ${sessionId} in Redis:`, err));

            // 将 transport 连接到 McpServer
            mcpServer.connect(transport)
                .then(() => console.log(`McpServer connected to transport for session ${sessionId}`))
                .catch(err => {
                    console.error(`Error connecting McpServer for session ${sessionId}:`, err);
                    transport.close(); // 连接失败时也清理
                });
        },
        cancel(reason) {
            console.log('SSE stream cancelled:', reason);
        }
    });

    // 返回 SSE 响应
    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        },
    });
}

/**
 * 处理 MCP 客户端发送的消息 (POST)
 */
export async function POST(req: NextRequest) {
    const sessionId = req.nextUrl.searchParams.get('sessionId');
    console.log(`Received POST request for MCP message (Session ID: ${sessionId})`);

    if (!sessionId) {
        console.error('POST request missing sessionId');
        return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }

    // 1. 验证 Session ID 是否仍在 Redis 中 (表示会话可能有效)
    try {
        const sessionExists = await redis.exists(`mcp_session:${sessionId}`);
        if (!sessionExists) {
            console.error(`Session ID ${sessionId} not found in Redis or expired.`);
            return NextResponse.json({ error: 'Invalid or expired session ID' }, { status: 400 });
        }
        redis.expire(`mcp_session:${sessionId}`, SESSION_EXPIRATION_SECONDS).catch(err => console.error(`Error refreshing expiry for session ${sessionId}:`, err));
    } catch (err) {
        console.error('Redis error checking session:', err);
        return NextResponse.json({ error: 'Internal server error checking session' }, { status: 500 });
    }

    // 2. 查找内存中的 transport
    const transport = activeTransports[sessionId];
    if (!transport) {
        console.error(`Transport not found in memory for Session ID ${sessionId}. Possible instance mismatch.`);
        return NextResponse.json({ error: 'Transport not found for session ID. Please reconnect.' }, { status: 400 });
    }

    // 3. 处理消息
    try {
        const messageString = await req.text();

        // 禁用 no-explicit-any 规则，因为 transport 类型与预期方法不匹配
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (typeof (transport as any).receiveMessage === 'function') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (transport as any).receiveMessage(messageString);
            console.log(`Message forwarded to transport for session ${sessionId}`);
            return NextResponse.json({ success: true });
        } else {
            console.warn(`Transport for session ${sessionId} does not have a receiveMessage method. Attempting handlePostMessage (may fail).`);

            let responseStatus = 200;
            let responseBody = '';
            const mockRes = {
                status: (code: number) => {
                    responseStatus = code;
                    return {
                        send: (body: string) => { responseBody = body; },
                        end: () => {}
                    };
                },
                send: (body: string) => { responseBody = body; },
                end: () => {}
            };

            // 禁用 no-explicit-any 规则，因为 req 和 mockRes 与 handlePostMessage 的预期类型不符
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await transport.handlePostMessage(req as any, mockRes as any);
            console.log(`handlePostMessage called for session ${sessionId}. Mock response status: ${responseStatus}`);
            return NextResponse.json(responseBody || { success: true }, { status: responseStatus });
        }

    } catch (error) {
        console.error(`Error processing POST message for session ${sessionId}:`, error);
        return NextResponse.json({ error: 'Failed to process message' }, { status: 500 });
    }
} 