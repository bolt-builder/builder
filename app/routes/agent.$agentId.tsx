import { Suspense } from 'react';
import { type LoaderFunctionArgs, type MetaFunction, useLoaderData } from 'react-router';
import { ComponentErrorBoundary } from '~/components/ui/ComponentErrorBoundary';
import { clientLazy } from '~/utils/react';

const AgentConsole = clientLazy(() =>
  import('~/components/agents/AgentConsole.client').then((m) => ({ default: m.AgentConsole })),
);

export async function loader({ params }: LoaderFunctionArgs) {
  const agentId = params.agentId;

  if (!agentId || !/^[\w-]+$/.test(agentId)) {
    throw new Response('A valid agent id is required', { status: 400 });
  }

  return Response.json({ agentId });
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const agentId = (data as { agentId?: string } | undefined)?.agentId ?? 'Agent';
  return [
    { title: `${agentId} · Bolt Agent Console` },
    { name: 'description', content: 'Chat with a CLI coding agent in a dedicated console' },
  ];
};

export default function AgentConsoleRoute() {
  const { agentId } = useLoaderData<typeof loader>();

  return (
    <main id="main-content" className="flex flex-col h-full w-full overflow-hidden">
      <ComponentErrorBoundary name="AgentConsole">
        <Suspense fallback={null}>
          <AgentConsole agentId={agentId} />
        </Suspense>
      </ComponentErrorBoundary>
    </main>
  );
}
