const { MatchingEngine, EngineOrder } = require("./engine");
const Fastify = require("fastify");
const mysql = require("mysql2/promise");

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
      "orders.quantity",
      "COALESCE(SUM(executions.quantity),0) as filled",
    ].join(", ") +
    " " +
    "FROM orders LEFT JOIN executions ON orders.secnum = executions.secnum " +
    "WHERE orders.filled = FALSE " +
    "GROUP BY orders.secnum";
  const [rows] = await pool.query(query);
  return rows;
}

async function handleExecutions(asks, bids) {
  if (asks.length === 0 && bids.length === 0) return;
  const totalExecs = asks.concat(bids);
  const insertPlaceholders = totalExecs.map((_) => "(?, ?)").join(", ");
  const insertQuery = `INSERT INTO executions (secnum, quantity) values ${insertPlaceholders}`;
  const values = totalExecs.map((exec) => [exec.secnum, exec.quantity]);
  let inserted = false;
  let updated = false;
  while (!inserted) {
    try {
      await pool.execute(insertQuery, values.flat());
      inserted = true;
    } catch (e) {
      console.error(e);
      continue;
    }
  }
  const updateQuery =
    "UPDATE orders LEFT JOIN (" +
    ["SELECT executions.secnum", "SUM(executions.quantity) as quantity"].join(
      ", ",
    ) +
    " " +
    `FROM executions ` +
    "GROUP BY executions.secnum) AS execs " +
    "ON orders.secnum = execs.secnum " +
    "SET orders.filled = TRUE " +
    "WHERE orders.quantity = execs.quantity " +
    "AND execs.quantity IS NOT NULL " +
    "AND orders.filled = FALSE";
  while (!updated) {
    try {
      await pool.query(updateQuery);
      updated = true;
    } catch (e) {
      console.error(e);
      continue;
    }
  }
}

const fastify = Fastify();
const symbols = ["AAPL", "AMZN", "MSFT", "GOOGL"];
const engine = new MatchingEngine(symbols);
const orderSet = new Set();

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

fastify.post("/order", async (request, reply) => {
  const rawOrder = request.body;
  const order = new EngineOrder(
    rawOrder.symbol,
    rawOrder.side,
    rawOrder.price,
    rawOrder.quantity,
    rawOrder.secnum,
  );
  const headers = { "Content-Type": "application/json" };
  const method = "POST";
  // handle if order is already in the engine
  if (orderSet.has(order.secnum)) return;
  else {
    // if the order has not yet been placed
    orderSet.add(order.secnum);
    engine.execute(order, (asks, bids) => {
      if (asks.length === 0 && bids.length === 0) return;
      const topSet = getTops();
      handleExecutions(asks, bids).then(() => {
        removeFromSet(topSet, asks);
        removeFromSet(topSet, bids);
        fetch(orderManagerUrl, {
          method: method,
          body: JSON.stringify(asks.concat(bids)),
          headers: headers,
        }).catch((e) => {
          console.error(e);
        });
      });
    });
  }
});

fastify.get("/", async (_, reply) => {
  return reply.code(201).send("Engine available");
});

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, addr) => {
  if (err) {
    console.error(err);
    process.exit(1);
  } else {
    console.log(`Server listening on port: ${addr}`);
    restoreEngine().then((placedOrders) => {
      const asksMap = new Map();
      const bidsMap = new Map();
      placedOrders.forEach((placedOrder) => {
        if (orderSet.has(placedOrder.secnum)) return;
        else {
          orderSet.add(placedOrder.secnum);
          engine.execute(
            {
              secnum: placedOrder.secnum,
              quantity: placedOrder.quantity - Number(placedOrder.filled),
              side: placedOrder.side,
              price: Number(placedOrder.price),
              symbol: placedOrder.symbol,
            },
            (asks, bids) => {
              if (asks.length === 0 && bids.length === 0) {
                return;
              } else {
                asks.forEach((ask) => {
                  const oldAsk = asksMap.get(ask.secnum);
                  if (oldAsk)
                    asksMap.set(ask.secnum, {
                      ...oldAsk,
                      quantity: oldAsk.quantity + ask.quantity,
                    });
                  else asksMap.set(ask.secnum, ask);
                });
                bids.forEach((bid) => {
                  const oldBid = bidsMap.get(bid.secnum);
                  if (oldBid)
                    bidsMap.set(bid.secnum, {
                      ...oldBid,
                      quantity: oldBid.quantity + bid.quantity,
                    });
                  else bidsMap.set(bid.secnum, bid);
                });
              }
            },
          );
        }
      });
      const totalAsks = Array.from(asksMap.values());
      const totalBids = Array.from(bidsMap.values());
      handleExecutions(totalAsks, totalBids).then(() => {
        const handleElement = (el) => {
          const idx = placedOrders.findIndex((e) => e.secnum === el.secnum);
          if (idx === -1)
            throw Error(`Index not found for ${el.side} ${el.secnum}`);
          const remainder =
            placedOrders[idx].quantity - Number(placedOrders[idx].filled);
          if (remainder === el.quantity) orderSet.delete(el.secnum);
        };
        totalAsks.forEach(handleElement);
        totalBids.forEach(handleElement);
        fetch(orderManagerUrl, {
          method: "POST",
          body: JSON.stringify(totalAsks.concat(totalBids)),
          headers: { "Content-Type": "application/json" },
        });
      });
    });
  }
});
