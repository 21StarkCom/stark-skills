const dagre = require('dagre');

const DAGRE_CONFIG = {
  rankdir: 'TB',
  nodesep: 40,
  ranksep: 60,
  marginx: 20,
  marginy: 20,
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 52;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw);
  const config = payload.config || {};

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    ...DAGRE_CONFIG,
    ...config,
    rankdir: config.rankdir || DAGRE_CONFIG.rankdir,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of payload.nodes || []) {
    graph.setNode(node.id, {
      width: node.width || NODE_WIDTH,
      height: node.height || NODE_HEIGHT,
    });
  }

  for (const edge of payload.edges || []) {
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  const nodes = graph.nodes().map((id) => {
    const node = graph.node(id);
    return { id, x: node.x, y: node.y };
  });

  process.stdout.write(`${JSON.stringify({ nodes })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
