const Heap = require("heap");

/* Creates a dictionary of two heaps, sorted by price. One ascending and the
 * other descending
 */
function createSideHeaps() {
  return {
    asks: new Heap((a, b) => {
      return a.price_level - b.price_level;
    }),
    bids: new Heap((a, b) => {
      return b.price_level - a.price_level;
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

  /**
   * This function takes and order and try to match it against the order book of the order's symbol.
   * The execution handler is a function that will process the two set of executions if the order is matched.
   * @param {EngineOrder} order - the new order that has to be executed
   * @param {Function} executionHandler the callback function that is called once an order has been executed
   */
  execute(order = new EngineOrder(), executionHandler) {
    let current_book = this.symbol_order_book.symbol_order_book_map.get(
      order.symbol,
    );

    if (order.side === "bid") {
      //bids
      if (order.price < current_book.bids.top()?.price_level) {
        //Adding the order to the book for matching later cause it has a low bid price wrt current biggest bid
        current_book.bids.push({ price_level: order.price, order: order });
      } else {
        //we can match the order cause there are orders cheaper then the bidding price.
        // const matched_elements = this._match(order, this.symbol_order_book);
        const matched_elements = this._matchBid(order, current_book.asks);

        if (matched_elements.remaining_qtty > 0) {
          // the quantinty needed by the bidder was insufficient by the asking price volume.
          order.quantity = matched_elements.remaining_qtty;
          current_book.bids.push({ price_level: order.price, order: order });
        }
        executionHandler(
          matched_elements.ask_executions,
          matched_elements.bid_executions,
        );
      }
    } else {
      //asks
      if (order.price > current_book.asks.top()?.price_level) {
        //Adding the order to the book for matching later cause it has a high ask price wrt current higher ask
        current_book.asks.push({ price_level: order.price, order: order });
      } else {
        //we can match the order cause there are order cheaper than the order's bidding price.
        const matched_elements = this._matchAsk(order, current_book.bids);
        // const matched_elements = this._match(order, this.symbol_order_book);
        if (matched_elements.remaining_qtty > 0) {
          // the quantinty needed by the bidder was sufficient by the asking price volume.
          order.quantity = matched_elements.remaining_qtty;
          current_book.asks.push({ price_level: order.price, order: order });
        }
        executionHandler(
          matched_elements.ask_executions,
          matched_elements.bid_executions,
        );
      }
    }
  }

  _matchBid(bid_order = new EngineOrder(), symbol_asks_heap = new Heap()) {
    let bid_amount = bid_order.quantity;
    let bid_price = bid_order.price;
    const ask_executions = [];
    const bid_executions = [];
    while (bid_price >= symbol_asks_heap.top()?.price_level && bid_amount > 0) {
      let ask_match = symbol_asks_heap.top();
      let rem_ask_amount = ask_match.order.quantity - bid_amount;
      if (rem_ask_amount >= 0) {
        ask_match.order.quantity = rem_ask_amount;

        let ask_match_clone = { ...ask_match.order };
        ask_match_clone.quantity = bid_amount;

        ask_executions.push(ask_match_clone); //report partial ask match
        bid_executions.push(bid_order); //report full bid match
      } else {
        ask_executions.push(symbol_asks_heap.pop().order);
      }

      if (rem_ask_amount < 0) {
        bid_amount = Math.abs(rem_ask_amount);
      } else {
        break;
      }
    }

    if (bid_order.quantity - bid_amount > 0) {
      let bid_order_clone = { ...bid_order };
      bid_order_clone.quantity = bid_order.quantity - bid_amount;
      bid_executions.push(bid_order_clone);
    }

    return { remaining_qtty: bid_amount, ask_executions, bid_executions };
  }

  _matchAsk(ask_order = new EngineOrder(), symbol_bids_heap = new Heap()) {
    let ask_amount = ask_order.quantity;
    const ask_executions = [];
    const bid_executions = [];
    while (
      ask_order.price <= symbol_bids_heap.top()?.price_level &&
      ask_amount > 0
    ) {
      let bid_match = symbol_bids_heap.top();
      let rem_bid_amount = bid_match.order.quantity - ask_amount;
      if (rem_bid_amount >= 0) {
        let bid_match_clone = { ...bid_match.order };
        bid_match_clone.quantity = ask_amount;

        bid_match.order.quantity = rem_bid_amount;
        bid_executions.push(bid_match_clone); //report full bid match
        ask_executions.push(ask_order); //report partial ask match
      } else {
        bid_executions.push(symbol_bids_heap.pop().order);
      }
      if (rem_bid_amount < 0) {
        ask_amount = Math.abs(rem_bid_amount);
      } else {
        break;
      }
    }

    if (ask_order.quantity - ask_amount > 0) {
      let ask_order_clone = { ...ask_order };
      ask_order_clone.quantity = ask_order.quantity - ask_amount;
      ask_executions.push(ask_order_clone);
    }

    return { remaining_qtty: ask_amount, ask_executions, bid_executions };
  }
}

module.exports = { MatchingEngine, EngineOrder };

