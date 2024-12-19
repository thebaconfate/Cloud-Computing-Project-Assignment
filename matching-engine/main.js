const { MatchingEngine, EngineOrder } = require("./engine");
const Fastify = require("fastify");
const mysql = require("mysql2/promise");
const rxjs = require("rxjs");
const Subject = rxjs.Subject;

const dbCredentials = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
};

Object.entries(dbCredentials).some((credential) => {
  if (!credential[1]) throw new Error(`Undefined credential ${credential[0]}`);
});

const pool = mysql.createPool(dbCredentials);

const orderManagerHost = "order-manager";
const orderManagerPort = 3000;
const orderManagerPath = "order-fill";
const orderManagerUrl = `http://${orderManagerHost}:${orderManagerPort}/${orderManagerPath}`;

async function restoreEngine() {
  const query =
    "SELECT " +
    [
      "orders.secnum",
      "orders.symbol",
      "orders.side",
      "orders.price",
      "orders.quantity_left as quantity",
    ].join(", ") +
    " " +
    "FROM orders " +
    "WHERE orders.quantity_left > 0";
  const [rows] = await pool.query(query);
  return rows.map((el) => {
    return {
      ...el,
      secnum: Number(el.secnum),
      price: Number(el.price),
      quantity: Number(el.quantity),
    };
  });
}

async function updateOrders(asks, bids) {
  const execs = new Map();
  const handleExec = (newExec) => {
    const exec = execs.get(newExec.secnum);
    if (exec) {
      execs.set(exec.secnum, {
        ...exec,
        quantity: exec.quantity + newExec.quantity,
      });
    } else execs.set(newExec.secnum, newExec);
  };
  asks.forEach(handleExec);
  bids.forEach(handleExec);
  query =
    "UPDATE orders SET quantity_left = quantity_left - ? WHERE secnum = ?";
  const flattenedExecs = Array.from(execs.values());
  try {
    await Promise.all(
      flattenedExecs.map((exec) => {
        return pool.execute(query, [exec.quantity, exec.secnum]);
      }),
    );
    return {
      asks: flattenedExecs.filter((e) => e.side === "ask"),
      bids: flattenedExecs.filter((e) => e.side === "bid"),
    };
  } catch (e) {
    console.error(e);
  }
}

const fastify = Fastify();
const symbols = ["AAPL", "AMZN", "MSFT", "GOOGL"];
const engine = new MatchingEngine(symbols);
const orderSet = new Set();
const orderFeeder = new Subject();

function removeFromSet(topSet, array) {
  array.forEach((val) => {
    if (!topSet.has(val.secnum)) orderSet.delete(val.secnum);
  });
}

function getTops() {
  const orderbookMap = engine.symbol_order_book.symbol_order_book_map;
  return symbols.reduce((prev, next) => {
    const orderBook = orderbookMap.get(next);
    if (orderBook.asks.top()) prev.add(orderBook.asks.top().secnum);
    if (orderBook.bids.top()) prev.add(orderBook.bids.top().secnum);
    return prev;
  }, new Set());
}

function handleExecutions(asks, bids) {
  if (asks.length === 0 && bids.length === 0) return;
  const tops = getTops();
  updateOrders(asks, bids)
    .then((execs) => {
      removeFromSet(tops, execs.asks);
      removeFromSet(tops, execs.bids);
      fetch(orderManagerUrl, {
        method: "POST",
        body: JSON.stringify({ asks: execs.asks, bids: execs.bids }),
        headers: { "Content-Type": "application/json" },
      });
    })
    .catch((e) => {
      console.error(e);
    });
}

orderFeeder.subscribe((engineOrder) => {
  if (orderSet.has(engineOrder.secnum)) return;
  orderSet.add(engineOrder.secnum);
  engine.execute(engineOrder, handleExecutions);
});

fastify.post("/order", async (request) => {
  const rawOrder = request.body;
  const order = new EngineOrder(
    rawOrder.symbol,
    rawOrder.side,
    rawOrder.price,
    rawOrder.quantity,
    rawOrder.secnum,
  );
  orderFeeder.next(order);
  return;
});

fastify.get("/", async (_, reply) => {
  return reply.code(200).send("Engine available");
});

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, addr) => {
  if (err) {
    console.error(err);
    process.exit(1);
  } else {
    console.log(`Server listening on port: ${addr}`);
    restoreEngine().then((placedOrders) => {
      placedOrders.forEach((order) =>
        orderFeeder.next(
          new EngineOrder(
            order.symbol,
            order.side,
            order.price,
            order.quantity,
            order.secnum,
          ),
        ),
      );
    });
  }
});
