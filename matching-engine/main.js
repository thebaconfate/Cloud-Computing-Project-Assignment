const Heap = require("heap");

// NOTE: Bids are "buy" orders
// NOTE: Asks are "sell" prders

/* Creates a dictionary of two heaps, sorted by price. One ascending and the
 * other descending
 */
function createSideHeaps() {
  // lowest ask is always top
  // highest bid is always top
  return {
    asks: new Heap((a, b) => {
      return a.price_level - b.price_level; // sorted ascending (low to high)
    }),
    bids: new Heap((a, b) => {
      return b.price_level - a.price_level; // sorted descending (high to low)
    }),
  };
}

/**
 * Represents an order in the system
 * @class EngineOrder
 */
class EngineOrder {
  /**
   * Creates a new order for the engine
   * @constructor
   * @param {string} symbol - The name of a stock
   * @param {string} side - "ask" or "bid"
   * @param {number} price - the price of the order
   * @param {number} quantity - the amount of stocks in the order
   * @param {number} secnum - the sequential number given in the order manager
   */
  constructor(symbol = "", side = "", price = 0, quantity = 0, secnum = 0) {
    this.symbol = symbol;
    this.side = side;
    this.price = price;
    this.quantity = quantity;
    this.secnum = secnum;
  }
}

/**
 * @class Orderbook
 */
class OrderBook {
  /**
   * Creates and OrderBook
   * @constructor
   * @param {string[]} symbols - The array of symbols that the book has to create side heaps for
   */
  constructor(symbols = []) {
    this.symbol_order_book_map = new Map();
    for (const sym of symbols) {
      this.symbol_order_book_map.set(sym, createSideHeaps());
    }
  }
}

/**
 * This class implements the matching algorithm
 * It takes the array of stocks supported by the market and maintains a book for each symbol.
 * Currently only for symbols are traded in the dataset.
 * Therefore you should instantaiate with those symbols => ['AAPL', 'GOOGL', 'MSFT', 'AMZN']
 * MatchingEngine
 * @class
 */
class MatchingEngine {
  constructor(symbols = []) {
    this.symbols = symbols;
    this.symbol_order_book = new OrderBook(symbols);
  }

  execute(order = new EngineOrder(), executionHandler) {
    const symbol_book = this.symbol_order_book.symbol_order_book_map.get(
      order.symbol,
    );

    const bids = symbol_book.bids;
    const asks = symbol_book.asks;

    //first, pushing the incoming order into the book.
    if (order.side === "bid") {
      bids.push({ price_level: order.price, order: order });
    } else {
      asks.push({ price_level: order.price, order: order });
    }

    const executed_bids = [];
    const executed_asks = [];

    //then matching and executing while bid.top <= ask.top
    while (
      bids.top() &&
      asks.top() &&
      bids.top().price_level >= asks.top().price_level
    ) {
      const topb = bids.top();
      const topa = asks.top();
      //computing the trade quantity for the top bid (highest) and ask(lowest) orders in the book
      const tradeQtty = Math.min(topb.order.quantity, topa.order.quantity);

      //performing the trade
      topb.order.quantity = topb.order.quantity - tradeQtty;
      topa.order.quantity = topa.order.quantity - tradeQtty;

      //creating the order executions.
      const bidExec = structuredClone(topb.order);
      const askExec = structuredClone(topa.order);
      bidExec.quantity = tradeQtty;
      askExec.quantity = tradeQtty;

      //collecting the executions on current iteration
      executed_bids.push(bidExec);
      executed_asks.push(askExec);

      //the order is removed from the heap whenever its quantity reaches 0
      if (topb.order.quantity === 0) {
        bids.pop();
      }
      if (topa.order.quantity === 0) {
        asks.pop();
      }
    }

    executionHandler(executed_asks, executed_bids);
  }
}

module.exports = { MatchingEngine, EngineOrder };
