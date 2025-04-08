import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// 创建 McpServer 实例
const mcpServer = new McpServer({
  name: "mcp-nextjs-echo-server",
  version: "1.0.0"
});

// --- Echo 示例 --- 

// 1. Echo 资源
mcpServer.resource(
  "echo",
  new ResourceTemplate("echo://{message}", { list: undefined }),
  async (uri, { message }) => ({
    contents: [{
      uri: uri.href,
      text: `Resource echo: ${message}`
    }]
  })
);

// 2. Echo 工具
mcpServer.tool(
  "echo",
  { message: z.string({ description: "The message to echo back." }) },
  async ({ message }) => ({
    content: [{ type: "text", text: `Tool echo: ${message}` }]
  })
);

// 3. Echo 提示
mcpServer.prompt(
  "echo",
  { message: z.string({ description: "The message for the prompt." }) },
  ({ message }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Please process this message: ${message}`
      }
    }]
  })
);

// --- 结束 Echo 示例 ---

// 您可以在这里添加更多的资源、工具和提示

export default mcpServer;
