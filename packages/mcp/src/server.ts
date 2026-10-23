import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Id } from '../../contracts/src/index.js';
import { TaskService } from '../../core/src/tasks/service.js';
import {
  UiWorkflow,
  workflowInstructions,
  toolDefinitions,
} from '../../core/src/workflow/facade.js';
/**
 * 创建 MCP 协议适配器：注册五个工具及报告/图像资源，把请求转交共享业务门面。
 * 实际评测由 TaskService 与 worker 执行，此函数只定义可供客户端调用的能力。
 */
export function createMcpServer(service: TaskService) {
  const server = new McpServer(
    { name: 'leeway-ui-check', version: '0.1.0' },
    { instructions: workflowInstructions },
  );
  const workflow = new UiWorkflow(service);
  // 工具定义集中维护，MCP 这里只做协议适配，避免与 CLI 的业务逻辑分叉。
  for (const [name, definition] of Object.entries(toolDefinitions)) {
    const registered = server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.input.shape,
        outputSchema: definition.output.shape,
      },
      async (input: unknown) => {
        try {
          // SDK 将 tools/call 的 arguments 传入此回调，再由门面按工具名分发。
          const result = await workflow.call(name, input);
          return {
            // 同一结果同时提供文本与结构化表示，由 SDK 编码后返回客户端。
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: error instanceof Error ? error.message : 'tool_failed',
              },
            ],
          };
        }
      },
    );
    // SDK 1.x rebuilds raw shapes with strip semantics. Keep the shared strict contracts
    // so unsupported target build/start inputs are rejected identically in CLI and MCP.
    registered.inputSchema = definition.input;
    registered.outputSchema = definition.output;
  }
  // 按评测 ID 读取完整持久报告；submit/status 默认只返回有大小上限的摘要。
  server.registerResource(
    'evaluation-report',
    new ResourceTemplate('harness://evaluations/{evaluation_id}', { list: undefined }),
    { description: 'Complete persisted evaluation report including visual evidence' },
    async (uri, { evaluation_id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(service.getEvaluation(Id.parse(evaluation_id))),
        },
      ],
    }),
  );
  // 按证据 ID 读取参考图、截图、差异图或 JSON；harness:// 是 MCP 资源标识。
  server.registerResource(
    'artifact',
    new ResourceTemplate('harness://artifacts/{artifact_id}', { list: undefined }),
    { description: 'Immutable capture, diff or JSON report' },
    async (uri, { artifact_id }) => {
      const a = service.getArtifact(Id.parse(artifact_id)),
        data = await service.artifacts.read(a);
      if (data.length > 16_000_000) throw Error('artifact_too_large_for_mcp_use_local_report');
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: a.media_type,
            // 二进制证据使用 base64，文本证据使用 UTF-8；mimeType 告知客户端如何解读。
            ...(a.media_type.startsWith('image/') || a.media_type === 'application/octet-stream'
              ? { blob: data.toString('base64') }
              : { text: data.toString('utf8') }),
          },
        ],
      };
    },
  );
  return server;
}
