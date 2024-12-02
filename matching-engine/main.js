import { MatchingEngine, EngineOrder } from "./engine";
import Fastify from "fastify";
import mysql from "mysql2/promise";

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

const symbol = process.env.SYMBOL;
if (!symbol) throw new Error("No symbol declared for the engine");

const pool = mysql.createPool(dbCredentials);
await pool.execute(
  "CREATE TABLE IF NOT EXISTS executions (" +
    [
      "secnum INT NOT NULL",
      "quantity INT NOT NULL",
      "FOREIGN KEY (secnum) REFERENCES orders(secnum)",
    ].join(", ") +
    ")",
);

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
    "FROM orders LEFT JOIN executions WHERE orders.filled = FALSE GROUP BY orders.id " +
    "WHERE orders.symbol = ?";
  const [rows] = pool.query(query, [symbol]);
  return rows;
}

async function handleExecutions(asks, bids) {
  return pool
    .beginTransaction()
    .then(() => {
      const query = "INSERT INTO executions values ?";
      const values = asks
        .map((ask) => [ask.secnum, ask.quantity])
        .concat(bids.map((bid) => [bid.secnum, bid.quantity]));
      const placeholders = values.map((_) => "?").join(", ");
      pool.execute(query, [values]).then((_) => {
        const query =
          "UPDATE orders LEFT JOIN (" +
          [
            "SELECT executions.secnum",
            "SUM(executions.quantity) as quantity",
          ].join(", ") +
          `FROM executions WHERE executions IN (${placeholders}) ` +
          "GROUP BY executions.secnum) " +
          "ON orders.secnum = executions.secnum " +
          "SET orders.filled = TRUE " +
          "WHERE orders.quantity = executions.quantity " +
          "AND executions.quantity IS NOT NULL " +
          "AND orders.filled = FALSE";
        const secnums = values.map((value) => value[0]);
        pool.query(query, [secnums]).then((_) => {
          pool.commit();
        });
      });
    })
    .catch((e) => {
      pool.rollback().then(() => {
        throw e;
      });
    });
}

const fastify = Fastify();
const engine = new MatchingEngine([symbol]);
let restoredAsks = [];
let restoredBids = [];

fastify.post("/", async (request, replyTo) => {
  request.json().then((rawOrder) => {
    const order = new EngineOrder(
      rawOrder.symbol,
      rawOrder.side,
      rawOrder.price,
      rawOrder.quantity,
      rawOrder.secnum,
    );
    engine.execute(order, (asks, bids) => {
      // Early cutoff to not unecessarily interact with database
      if (asks.length === 0 && bids.length === 0) {
        replyTo.status(200).send();
      } else {
        if (restoredAsks || restoredBids) {
          asks = asks.concat(restoredAsks);
          bids = bids.concat(restoredBids);
          restoredAsks = null;
          restoredBids = null;
        }
        handleExecutions(asks, bids)
          .then(() => {
            replyTo.status(201).send(asks.concat(bids));
          })
          .catch((e) => {
            console.log(e);
            replyTo.status(500).send();
            restoreEngine().then((placedOrders) => {
              placedOrders.forEach((placedOrder) => {
                engine.execute(placedOrder, (asks, bids) => {
                  if (asks.length === 0 && bids.length === 0) return;
                  else {
                    restoredAsks = restoredAsks.concat(asks);
                    restoredBids = restoredBids.concat(bids);
                  }
                });
              });
            });
          });
      }
    });
  });
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
          if (asks.length === 0 && bids.length === 0) return;
          else {
            restoredAsks = restoredAsks.concat(asks);
            restoredBids = restoredBids.concat(bids);
          }
        });
      });
    });
  }
});
