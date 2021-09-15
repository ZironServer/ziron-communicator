# ziron-ts-engine
This module is the implementation of the protocol that is used in the server and client of Ziron. 

The protocol has two possible ways to communicate between two transporter and is blazing fast. 
Invokes represent the request/response principle. 
For example, A sends something to B and expects a response back. 
Transmits represent a simple transmit from A to B without a response from B. 
All data that is sent in invokes or transmits can be JSON content, binary or a stream. 
It is even possible to have JSON data that contains binary data or streams. 
Streams can be used to stream data in chunks from one to the other side. 
The streams are fully compatible with Node.Js streams and feature-rich.
It is possible to use the implementation in any underlying structure that supports a bidirectional connection.
