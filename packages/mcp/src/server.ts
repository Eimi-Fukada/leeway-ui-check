import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Id } from '../../contracts/src/index.js';
import { TaskService } from '../../core/src/tasks/service.js';
import {
  UiWorkflow,
  workflowInstructions,
  toolDefinitions,
} from '../../core/src/workflow/facade.js';
export function createMcpServer(service: TaskService) {
  const server = new McpServer(
    { name: 'leeway-ui-check', version: '0.1.0' },
    { instructions: workflowInstructions },
  );
  const workflow = new UiWorkflow(service);
  for (const [name, definition] of Object.entries(toolDefinitions)) {
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.input.shape,
        outputSchema: definition.output.shape,
      },
      async (input: unknown) => {
        try {
          const result = await workflow.call(name, input);
          return {
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
  }
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
