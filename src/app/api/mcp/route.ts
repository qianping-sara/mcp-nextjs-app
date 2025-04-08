import { NextRequest, NextResponse } from 'next/server';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import mcpServer from '../../../lib/server';
import redis from '../../../lib/redis';

// 重要提示：在 Serverless 环境中，此内存映射仅在单个函数实例的生命周期内有效。
// 如果 GET 和 POST 请求命中不同的实例，会话将无法找到。
const activeTransports: { [sessionId: string]: SSEServerTransport } = {};

// Redis 中 Session ID 的过期时间（秒），例如 1 小时
const SESSION_EXPIRATION_SECONDS = 3600;

/**
 * 处理 MCP 客户端的 SSE 连接请求 (GET)
 */
export async function GET(req: NextRequest) {
    console.log('Received GET request for MCP SSE connection');

    // 创建一个 ReadableStream 和对应的 writer
    const stream = new ReadableStream({
        start(controller) {
            // 创建 SSEServerTransport
            // postPath 指向我们自己，因为 POST 请求也发到 /api/mcp
            const transport = new SSEServerTransport('/api/mcp', {
                // 提供一个 write 函数给 transport 用于发送 SSE 数据
                write: (chunk) => {
                    try {
                        controller.enqueue(Buffer.from(chunk)); // 确保编码正确
                        // console.log(`SSE Sent Chunk (Session: ${transport.sessionId}):`, chunk.substring(0, 100) + '...'); // 日志，可能过多
                    } catch (e) {
                        console.error(`Error enqueueing SSE chunk for session ${transport.sessionId}:`, e);
                        try { controller.close(); } catch {} // 出错时尝试关闭
                    }
                },
                // 提供一个 end 函数
                end: () => {
                    console.log(`SSE stream ending for session ${transport.sessionId}`);
                    try { controller.close(); } catch {} // 确保流关闭
                },
                // 提供 close 事件处理（模拟 Response 的 close）
                onClose: () => {
                    console.log(`SSE connection closed for session ${transport.sessionId}. Cleaning up.`);
                    // 从内存和 Redis 中清理
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

            // 注意：此处不直接返回 transport.response，而是返回我们创建的流
        },
        cancel(reason) {
            console.log('SSE stream cancelled:', reason);
            // 通常在客户端断开连接时触发
            // onClose 应该已经处理了清理逻辑，但可以加一层保险
            // 需要找到与此 controller 相关联的 sessionId 来清理
            // 这比较困难，依赖 onClose 更可靠
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
        // 可选：刷新 Redis 中的过期时间
        redis.expire(`mcp_session:${sessionId}`, SESSION_EXPIRATION_SECONDS).catch(err => console.error(`Error refreshing expiry for session ${sessionId}:`, err));
    } catch (err) {
        console.error('Redis error checking session:', err);
        return NextResponse.json({ error: 'Internal server error checking session' }, { status: 500 });
    }

    // 2. 查找内存中的 transport
    const transport = activeTransports[sessionId];
    if (!transport) {
        console.error(`Transport not found in memory for Session ID ${sessionId}. Possible instance mismatch.`);
        // 这是 Serverless 环境中的预期问题
        return NextResponse.json({ error: 'Transport not found for session ID. Please reconnect.' }, { status: 400 });
    }

    // 3. 处理消息
    try {
        // SSEServerTransport.handlePostMessage 期望 express req/res 对象。
        // 我们需要模拟这个行为或找到替代方法。
        // 尝试直接调用 transport 内部处理消息的方法（如果 SDK 暴露了的话）。
        // 假设 transport 有一个类似 receiveMessage 的方法，或者 handlePostMessage 能处理原始请求体。

        // 最直接的方法是尝试调用 handlePostMessage，但它可能失败，因为它内部可能依赖 Express 的 API。
        // const mockRes = { status: (code) => ({ send: (body) => console.log('Mock response:', code, body) }) };
        // await transport.handlePostMessage(req as any, mockRes as any);

        // 更安全的方式：直接读取 body 并尝试调用 transport 内部的消息处理逻辑。
        // 这需要了解 SSEServerTransport 的内部实现，或者 SDK 提供更底层的接口。
        // 以下是一个尝试性的实现，假设我们可以调用 transport.receiveMessage(string)

        const messageString = await req.text();
        // console.log(`Received message string for session ${sessionId}:`, messageString);

        if (typeof (transport as any).receiveMessage === 'function') {
            await (transport as any).receiveMessage(messageString); // 假设存在此方法
            console.log(`Message forwarded to transport for session ${sessionId}`);
            return NextResponse.json({ success: true }); // 告知客户端消息已收到
        } else {
            // 如果没有 receiveMessage，尝试调用 handlePostMessage，但这风险很大
            console.warn(`Transport for session ${sessionId} does not have a receiveMessage method. Attempting handlePostMessage (may fail).`);

            // *** 警告：以下代码极有可能因为类型不匹配或内部依赖而失败 ***
            // 这是 SSEServerTransport 在非 Express 环境下的主要限制
            // 我们需要一个模拟的 Response 对象，至少有 status 和 send 方法
            let responseStatus = 200;
            let responseBody = '';
            const mockRes = {
                status: (code: number) => {
                    responseStatus = code;
                    return {
                        send: (body: string) => { responseBody = body; },
                        end: () => {} // handlePostMessage 可能调用 end
                    };
                },
                send: (body: string) => { responseBody = body; }, // 如果直接调用 send
                end: () => {} // 可能直接调用 end
            };

            await transport.handlePostMessage(req as any, mockRes as any);
            console.log(`handlePostMessage called for session ${sessionId}. Mock response status: ${responseStatus}`);
            // 根据 handlePostMessage 的行为返回响应
            // 通常它会发送一个 200 OK 或错误状态
            return NextResponse.json(responseBody || { success: true }, { status: responseStatus });
        }

    } catch (error) {
        console.error(`Error processing POST message for session ${sessionId}:`, error);
        return NextResponse.json({ error: 'Failed to process message' }, { status: 500 });
    }
}
