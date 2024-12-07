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

const SYMBOL = process.env.SYMBOL;
if (!SYMBOL) throw new Error("No symbol declared for the engine");

const pool = mysql.createPool(dbCredentials);

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
    "WHERE orders.filled = FALSE AND orders.symbol = ? " +
    "GROUP BY orders.secnum";
  const [rows] = await pool.query(query, [SYMBOL]);
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
const engine = new MatchingEngine([SYMBOL]);
const orderSet = new Set();

function removeFromSet(top, array) {
  array.forEach((val) => {
    if (!top || top.secnum != val.secnum) orderSet.delete(val.secnum);
  });
}
let restoredAsks = [];
let restoredBids = [];

fastify.post("/", async (request, replyTo) => {
  const rawOrder = request.body;
  console.log("received request");
  console.log(rawOrder);
  const order = new EngineOrder(
    rawOrder.symbol,
    rawOrder.side,
    rawOrder.price,
    rawOrder.quantity,
    rawOrder.secnum,
  );
  const orderBook = engine.symbol_order_book.symbol_order_book_map.get(SYMBOL);
  // handle if order is already in the engine
  if (orderSet.has(order.secnum)) {
    // if the engine was recently restored we need to return those executions too
    if (restoredAsks || restoredBids) {
      const asksCopy = restoredAsks;
      const bidsCopy = restoredBids;
      restoredBids = null;
      restoredAsks = null;
      const askTop = orderBook.asks.top();
      const bidTop = orderBook.bids.top();
      handleExecutions(asksCopy, bidsCopy).then(() => {
        removeFromSet(askTop, asksCopy);
        removeFromSet(bidTop, bidsCopy);
        replyTo.status(209).send(asksCopy.concat(bidsCopy));
      });
      // else just return empty array, since no executions to return
    } else replyTo.status(209).send([]);
  } else {
    // if the order has not yet been placed
    orderSet.add(order.secnum);
    // if the engine was recently restored
    if (restoredAsks || restoredBids) {
      const savedAskTop = orderBook.asks.top();
      const savedBidTop = orderBook.bids.top();
      engine.execute(order, (asks, bids) => {
        const toRemoveSecnums = restoredAsks
          .reduce((prev, next) => {
            if (savedAskTop !== next.secnum) {
              prev.push(next.secnum);
            }
            return prev;
          }, [])
          .concat(
            restoredBids.reduce((prev, next) => {
              if (savedBidTop !== next.secnum) {
                prev.push(next.secnum);
              }
              return prev;
            }, []),
          );
        const totalAsks = asks.concat(restoredAsks);
        const totalBids = bids.concat(restoredBids);
        restoredAsks = null;
        restoredBids = null;
        const askTop = orderBook.asks.top();
        const bidTop = orderBook.bids.top();
        handleExecutions(totalAsks, totalBids).then(() => {
          toRemoveSecnums.forEach((secnum) => orderSet.delete(secnum));
          removeFromSet(askTop, asks);
          removeFromSet(bidTop, bids);
          replyTo.status(201).send(totalAsks.concat(totalBids));
        });
      });
      // if engine wasn't restored recently
    } else {
      engine.execute(order, (asks, bids) => {
        const askTop = orderBook.asks.top();
        const bidTop = orderBook.bids.top();
        if (asks.length === 0 && bids.length === 0) {
          replyTo.status(200).send([]);
        } else {
          handleExecutions(asks, bids).then(() => {
            removeFromSet(askTop, asks);
            removeFromSet(bidTop, bids);
            replyTo.status(201).send(asks.concat(bids));
          });
        }
      });
    }
  }
});

fastify.get("/", async (_, replyTo) => {
  replyTo.status(200).send("Engine available");
});

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, addr) => {
  if (err) {
    console.error(err);
    process.exit(1);
  } else {
    console.log(`Server listening on port: ${addr}`);
    restoreEngine().then((placedOrders) => {
      placedOrders.forEach((placedOrder) => {
        engine.execute(placedOrder, (asks, bids) => {
          if (asks.length === 0 && bids.length === 0) {
            restoredAsks = null;
            restoredBids = null;
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
    });
  }
});
