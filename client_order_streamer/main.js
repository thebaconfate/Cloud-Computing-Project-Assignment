const assert = require("assert");
const fs = require("fs");
const split2 = require("split2");
const path = require("path");
const http = require("http");

const agent = new http.Agent({
  keepAlive: true,
});

/**
 * This file reads from the recorder client orders and emits requests to the specified endpoint
 **/

//TODO: You must adapt these to your own setting!
const end_host = "127.0.0.1";
const end_port = "3000";
const end_path = "";
const requestsPerSecond = 3;

const endpoint_url = `http://${end_host}:${end_port}/${end_path}`;

/**
 * Takes the dataset file's path and a callback that will process each line in the dataset
 * e.g. the function send that takes the line and makes a network request.
 * @param {String} cvs_filepath
 * @param {Function} record_handler
 */
function processFileContents(cvs_filepath, record_handler) {
  const order_stream = fs
    .createReadStream(cvs_filepath, { encoding: "utf-8", start: 0 })
    .pipe(split2());

  const processLineWithDelay = (line) => {
    record_handler(line);
    setTimeout(() => {
      order_stream.resume();
    }, 1000 / requestsPerSecond);
  };

  order_stream.on("data", (line) => {
    order_stream.pause();
    processLineWithDelay(line);
  });
}

/**
 * @param {String} line
 * @returns {JSON}
 */
function parseLine(line) {
  let fields_array = line.split(",");
  assert.equal(fields_array.length, 7, "Expected 7 fields!");
  return {
    user_id: fields_array[0],
    timestamp_ns: fields_array[1],
    price: fields_array[2],
    symbol: fields_array[3],
    quantity: fields_array[4],
    order_type: fields_array[5],
    trader_type: fields_array[6],
  };
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
    method: "POST",
    body: JSON.stringify(json_order),
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    agent: agent,
  })
    .then((_) => console.log(`Sent ${json_order}`))
    .catch((e) => console.error(e));
}

const CSVDir = path.join(__dirname, "../order_datasets");

fs.readdir(CSVDir, (err, files) => {
  if (err) {
    console.error(err);
    return;
  } else {
    files = files.filter((file) => file.endsWith(".csv"));
    //files.forEach((file) => console.log(file));
    processFileContents(path.join(CSVDir, files[1]), (line) => send(line));
  }
});
