# ziron
This module is the implementation of the Zations 'Ziron' protocol that is used in the core server and client of Zation. 

The protocol has two possible ways to communicate between two communicators and is blazing fast. 
Invokes represent the request/response principle. 
For example, A sends something to B and expects a response back. 
Transmits represent a simple transmit from A to B without a response from B. 
All data that is sent in invokes or transmits can be JSON content, binary or a stream. 
With the MixedJSON class, it is possible to have JSON content that contains binary data or streams. 
Streams can be used to stream data in chunks from one to the other side. 
The Ziron implementation can be used in any underlying structure that supports a bidirectional connection.
