const assert = require("assert");
const fs = require("fs");
const split2 = require('split2');

/** 
 * This file reads from the recorder client orders and emits requests to the specified endpoint
 **/

//TODO: You must adapt these to your own setting!
const end_host = "";
const end_port = "";
const end_path = "";

const endpoint_url = `http://${end_host}:${end_port}/${end_path}`;

/**
 * Takes the dataset file's path and a callback that will process each line in the dataset 
 * e.g. the function send that takes the line and makes a network request.
 * @param {String} cvs_filepath 
 * @param {Function} record_handler 
 */
function processFileContents(cvs_filepath, record_handler) {
    const order_stream = fs.createReadStream(cvs_filepath, { encoding: "utf-8", start: 0 }).pipe(split2());
    order_stream.on('data', (line) => {
        record_handler(line)
    })
}

/**
 * @param {String} line 
 * @returns {JSON}
 */
function parseLine(line) {
    let fields_array = line.split(",");
    assert.equal(fields_array.length, 7, "Expected 7 fields!");
    return {
        "user_id": fields_array[0],
        "timestamp_ns": fields_array[1],
        "price": fields_array[2],
        "symbol": fields_array[3],
        "quantity": fields_array[4],
        "order_type": fields_array[5],
        "trader_type": fields_array[6]
    }
}


/**
 * 
 * This function makes a POST request the configured end_url.
 * It uses JSON as the request's body format to attach the order.
 * 
 */
function send(order_line) {
    const json_order = parseLine(order_line);
    fetch(endpoint_url, {
        method: "PUSH",
        body: JSON.stringify(json_order),
        keepalive: true
    });
}