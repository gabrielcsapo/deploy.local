'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';

interface DemoNodeData extends Record<string, unknown> {
  kind: 'service' | 'resource';
  title: string;
  subtitle: string;
  status: string;
  meta: string;
  glyph: string;
}

type DemoNode = Node<DemoNodeData, 'demo'>;

const INITIAL_NODES: DemoNode[] = [
  {
    id: 'web',
    type: 'demo',
    position: { x: 70, y: 80 },
    data: {
      kind: 'service',
      title: 'web',
      subtitle: 'family.local',
      status: 'Online',
      meta: '2 instances · 1 port',
      glyph: 'WE',
    },
  },
  {
    id: 'worker',
    type: 'demo',
    position: { x: 450, y: 24 },
    data: {
      kind: 'service',
      title: 'worker',
      subtitle: 'background jobs',
      status: 'Online',
      meta: '1 instance · private',
      glyph: 'WK',
    },
  },
  {
    id: 'database',
    type: 'demo',
    position: { x: 450, y: 205 },
    data: {
      kind: 'service',
      title: 'Postgres',
      subtitle: 'managed database',
      status: 'Healthy',
      meta: '1 instance · private',
      glyph: 'PG',
    },
  },
  {
    id: 'database-data',
    type: 'demo',
    position: { x: 790, y: 205 },
    data: {
      kind: 'resource',
      title: 'database-data',
      subtitle: 'database · durable',
      status: 'Ready',
      meta: '7 daily backups',
      glyph: 'DB',
    },
  },
];

const INITIAL_EDGES: Edge[] = [
  { id: 'web-worker', source: 'web', target: 'worker' },
  { id: 'web-database', source: 'web', target: 'database' },
  { id: 'database-volume', source: 'database', target: 'database-data' },
].map((edge) => ({
  ...edge,
  type: 'smoothstep',
  animated: false,
  markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
  style: { strokeWidth: 1.2 },
}));

function DemoFlowNode({ data, selected }: NodeProps<DemoNode>) {
  return (
    <article
      className={`landing-flow-card ${data.kind === 'resource' ? 'is-resource' : ''} ${selected ? 'is-selected' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="application-flow-handle" />
      <span className={`workspace-glyph ${data.kind === 'resource' ? 'is-resource' : ''}`}>
        {data.glyph}
      </span>
      <span className="landing-flow-card-copy">
        <strong>{data.title}</strong>
        <small>{data.subtitle}</small>
      </span>
      <span className="application-service-health tone-success">
        <i aria-hidden /> {data.status}
      </span>
      <span className="landing-flow-card-meta">{data.meta}</span>
      <Handle type="source" position={Position.Right} className="application-flow-handle" />
    </article>
  );
}

const NODE_TYPES = { demo: DemoFlowNode };

export function LandingApplicationCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<DemoNode>(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(INITIAL_EDGES);
  const [selected, setSelected] = useState<DemoNodeData | null>(null);
  const nodeTypes = useMemo(() => NODE_TYPES, []);
  const onConnect = useCallback(
    (connection: Connection) => setEdges((current) => addEdge(connection, current)),
    [setEdges],
  );

  function addService() {
    if (nodes.some((node) => node.id === 'scheduler')) {
      setSelected(nodes.find((node) => node.id === 'scheduler')?.data ?? null);
      return;
    }
    const scheduler: DemoNode = {
      id: 'scheduler',
      type: 'demo',
      position: { x: 70, y: 280 },
      data: {
        kind: 'service',
        title: 'scheduler',
        subtitle: 'new component',
        status: 'Ready to deploy',
        meta: '1 instance · private',
        glyph: 'SC',
      },
    };
    setNodes((current) => [...current, scheduler]);
    setEdges((current) => [
      ...current,
      {
        id: 'web-scheduler',
        source: 'web',
        target: 'scheduler',
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      },
    ]);
    setSelected(scheduler.data);
  }

  return (
    <section className="welcome-canvas" aria-label="Interactive example application canvas">
      <header>
        <span>
          <strong>family-cloud</strong>
          <small>Production</small>
        </span>
        <span className="welcome-canvas-status">
          <i aria-hidden /> Online
        </span>
        <button type="button" onClick={addService}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add service
        </button>
      </header>
      <div className="welcome-flow-viewport application-canvas-viewport">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelected(node.data)}
          onPaneClick={() => setSelected(null)}
          fitView
          fitViewOptions={{ padding: 0.16 }}
          minZoom={0.55}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          aria-label="family-cloud application topology"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#4c4658" />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="welcome-flow-hint">Drag nodes · pan the canvas · scroll to zoom</div>
        {selected ? (
          <aside className="welcome-flow-detail" aria-live="polite">
            <button type="button" onClick={() => setSelected(null)} aria-label="Close details">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
            <small>{selected.kind === 'resource' ? 'Durable resource' : 'Component'}</small>
            <strong>{selected.title}</strong>
            <p>{selected.subtitle}</p>
            <span>
              <i aria-hidden /> {selected.status}
            </span>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
