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
  const conn = await pool.getConnection();
  const totalExecs = asks.concat(bids);
  conn.beginTransaction();
  const insertPlaceholders = totalExecs.map((_) => "(?, ?)").join(", ");
  const query = `INSERT INTO executions (secnum, quantity) values ${insertPlaceholders}`;
  const values = totalExecs.map((exec) => [exec.secnum, exec.quantity]);
  try {
    conn.execute(query, values.flat()).then((_) => {
      const query =
        "UPDATE orders LEFT JOIN (" +
        [
          "SELECT executions.secnum",
          "SUM(executions.quantity) as quantity",
        ].join(", ") +
        " " +
        `FROM executions WHERE executions.secnum IN (?) ` +
        "GROUP BY executions.secnum) AS execs " +
        "ON orders.secnum = execs.secnum " +
        "SET orders.filled = TRUE " +
        "WHERE orders.quantity = execs.quantity " +
        "AND execs.quantity IS NOT NULL " +
        "AND orders.filled = FALSE";
      const secnums = values.map((value) => value[0]);
      conn.query(query, [secnums]).then((_) => {
        conn.commit();
      });
    });
  } catch (e) {
    console.error(e);
    await conn.rollback();
  } finally {
    conn.release();
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
let restoredAsks = null;
let restoredBids = null;

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
  if (orderSet.has(order.secnum)) {
    // if the engine was recently restored we need to return those executions too
    if (restoredAsks || restoredBids) {
      // need to create a copy due to it being used in a callback funtion
      const asksCopy = restoredAsks;
      const bidsCopy = restoredBids;
      // point the restored execs to null so the main thread doesn't use it again
      restoredBids = null;
      restoredAsks = null;
      const topSet = getTops();
      await handleExecutions(asksCopy, bidsCopy);
      removeFromSet(topSet, asksCopy);
      removeFromSet(topSet, bidsCopy);
      fetch(orderManagerUrl, {
        method: method,
        body: JSON.stringify(asksCopy.concat(bidsCopy)),
        headers: headers,
      }).catch((e) => {
        console.error(e);
      });
    }
    // else just return empty array, since no executions to return
  } else {
    // if the order has not yet been placed
    orderSet.add(order.secnum);
    // if the engine was recently restored
    if (restoredAsks || restoredBids) {
      const savedTopSet = getTops();
      engine.execute(order, (asks, bids) => {
        const toRemoveSecnums = restoredAsks
          .reduce((prev, next) => {
            if (!savedTopSet.has(next.secnum)) {
              prev.push(next.secnum);
            }
            return prev;
          }, [])
          .concat(
            restoredBids.reduce((prev, next) => {
              if (!savedTopSet.has(next.secnum)) {
                prev.push(next.secnum);
              }
              return prev;
            }, []),
          );
        const totalAsks = asks.concat(restoredAsks);
        const totalBids = bids.concat(restoredBids);
        restoredAsks = null;
        restoredBids = null;
        const topSet = getTops();
        handleExecutions(totalAsks, totalBids).then(() => {
          toRemoveSecnums.forEach((secnum) => orderSet.delete(secnum));
          removeFromSet(topSet, asks);
          removeFromSet(topSet, bids);
          fetch(orderManagerUrl, {
            method: method,
            body: JSON.stringify(totalAsks.concat(totalBids)),
            headers: headers,
          }).catch((e) => {
            console.error(e);
          });
        });
      });
      // if engine wasn't restored recently
    } else {
      engine.execute(order, (asks, bids) => {
        const topSet = getTops();
        if (asks.length === 0 && bids.length === 0) {
          return;
        } else {
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
        }
      });
    }
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
    restoreEngine()
      .then((placedOrders) => {
        placedOrders.forEach((placedOrder) => {
          engine.execute(placedOrder, (asks, bids) => {
            if (asks.length === 0 && bids.length === 0) {
              return;
            } else if (!restoredAsks || !restoredBids) {
              restoredBids = bids;
              restoredAsks = asks;
            } else {
              restoredAsks = restoredAsks.concat(asks);
              restoredBids = restoredBids.concat(bids);
            }
          });
        });
      })
      .then(() => {
        if (restoredBids || restoredAsks) {
          fetch(orderManagerUrl, {
            body: JSON.stringify(restoredAsks.concat(restoredBids)),
            method: "POST",
            headers: { "Content-Type": "application/json" },
          })
            .then((response) => {
              if (response.ok) {
                restoredAsks = null;
                restoredBids = null;
              }
            })
            .catch((e) => {
              console.error(e);
            });
        }
      });
  }
});
