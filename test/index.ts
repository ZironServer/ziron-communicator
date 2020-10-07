import {Communicator,JSONString,WriteStream,ReadStream,TimeoutError,ConnectionLostError,StreamCloseCode} from './../src/index';
import {expect} from 'chai';

const comA = new Communicator({
  onInvalidMessage: (err) => console.error('A: Invalid meessage: ', err),
  onListenerError: (err) => console.error('A: Listener err: ', err),
});
const comB = new Communicator({
  onInvalidMessage: (err) => console.error('B: Invalid meessage: ', err),
  onListenerError: (err) => console.error('B: Listener err: ', err),
});

//connect
comA.send = comB.emitMessage.bind(comB);
comB.send = comA.emitMessage.bind(comA);

describe('Ziron', () => {

  describe('Transmits', () => {

    it('B should receive the transmit with JSON data.', (done) => {
      const data = {name: 'Luca', age: 21};
      comB.onTransmit = (event,data) => {
        expect(event).to.be.equal('person');
        expect(data).to.be.deep.equal(data);
        done();
      };
      comA.transmit('person',data);
    });

    it('Transmit with circular JSON data should be handled.', (done) => {
      const data: any = {};
      data.more = data;
      comB.onTransmit = (event,data) => {
        expect(event).to.be.equal('circularJson');
        expect(data).to.be.deep.equal({more: '[Circular]'});
        done();
      };
      comA.transmit('circularJson',data);
    });

    it('B should receive the transmit with binary data.', (done) => {
      const data = new ArrayBuffer(10);
      comB.onTransmit = (event,data) => {
        expect(event).to.be.equal('binary');
        expect(data).to.be.deep.equal(data);
        done();
      };
      comA.transmit('binary',data);
    });

    it('B should receive the transmit with JSON string.', (done) => {
      const data = new JSONString('[]');
      comB.onTransmit = (event,data) => {
        expect(event).to.be.equal('jsonString');
        expect(data).to.be.deep.equal([]);
        done();
      };
      comA.transmit('jsonString',data);
    });

    it('B should receive the transmit with MixedJSON (JSON with binary).', (done) => {
      const images = {
        avatar: new ArrayBuffer(5),
        cover: new ArrayBuffer(15)
      }
      comB.onTransmit = (event,data) => {
        expect(event).to.be.equal('mixedJSONBinary');
        expect(data).to.be.deep.equal(images);
        done();
      };
      comA.transmit('mixedJSONBinary',images,{processComplexTypes: true});
    });

    it('B should receive the streamed json transmit data fully.', (done) => {
      const writeStream = new WriteStream();
      const writtenData: any[] = [];
      writeStream.onOpen = () => {
        for(let i = 0; i < 500; i++) {
          writtenData.push(i);
          writeStream.write(i);
        }
        writtenData.push(500);
        writeStream.writeAndClose(500,false,200);
      };
      comB.onTransmit = (event,data: ReadStream) => {
        expect(event).to.be.equal('streamJson');
        expect(data).to.be.instanceof(ReadStream);
        const chunks: any[] = [];
        data.onChunk = (chunk) => {
          chunks.push(chunk)
        };
        data.onClose = (code) => {
          expect(code).to.be.equal(200);
          expect(chunks).to.be.deep.equal(writtenData);
          done();
        };
        data.accept();
      };
      comA.transmit('streamJson',writeStream,{processComplexTypes: true});
    });

    it('B should receive the streamed binary transmit data fully.', (done) => {
      const writeStream = new WriteStream();
      const writtenData: any[] = [];
      writeStream.onOpen = () => {
        for(let i = 0; i < 100; i++) {
          const binary = new ArrayBuffer(i);
          writtenData.push(binary);
          writeStream.write(binary,true);
        }
        writeStream.close(200);
      };
      comB.onTransmit = (event,data: ReadStream) => {
        expect(event).to.be.equal('streamBinary');
        expect(data).to.be.instanceof(ReadStream);
        const chunks: any[] = [];
        data.onChunk = (chunk) => {
          chunks.push(chunk)
        };
        data.onClose = (code) => {
          expect(code).to.be.equal(200);
          expect(chunks).to.be.deep.equal(writtenData);
          done();
        };
        data.accept();
      };
      comA.transmit('streamBinary',writeStream,{processComplexTypes: true});
    });

    it("A's write stream should be closed when B closes the read stream.", (done) => {
      const writeStream = new WriteStream();
      writeStream.onClose = (code) => {
        expect(code).to.be.equal(505);
        done();
      };
      comB.onTransmit = (event,data: ReadStream) => {
        expect(event).to.be.equal('readStreamClose');
        expect(data).to.be.instanceof(ReadStream);
        data.close(505)
      };
      comA.transmit('readStreamClose',writeStream,{processComplexTypes: true});
    });

    it("Ignored read stream should end write stream with an accept timeout.", (done) => {
      WriteStream.acceptTimeout = 60;
      const writeStream = new WriteStream();
      writeStream.onClose = (code) => {
        expect(code).to.be.equal(StreamCloseCode.AcceptTimeout);
        done();
      };
      comB.onTransmit = (event,data: ReadStream) => {
        expect(event).to.be.equal('streamAcceptTimeout');
      };
      comA.transmit('streamAcceptTimeout',writeStream,{processComplexTypes: true});
    });


    it("An accept read stream which will not receive anything a certain time should end with ReceiveTimeout.", (done) => {
      const writeStream = new WriteStream();

      comB.onTransmit = (event,data: ReadStream) => {
        expect(event).to.be.equal('streamReceiveTimeout');

        data.onClose = (code) => {
          expect(code).to.be.equal(StreamCloseCode.ReceiveTimeout);
          done();
        }
        data.accept(60);

      };
      comA.transmit('streamReceiveTimeout',writeStream,{processComplexTypes: true});
    });

    it('All batch transmits should be received.', (done) => {
      const count = 10;

      let receivedI = 0;
      comB.onTransmit = (event,data) => {
        expect(event).to.be.equal('batch');
        expect(data).to.be.equal('msg');
        receivedI++;
        if(receivedI === count) done();
      };

      for(let i = 0; i < count; i++){
        comA.transmit('batch','msg',{batchTimeLimit: 50});
      }
    });

  });

  describe('Invokes', () => {

    it('A should receive the response of invoke with JSON data.', (done) => {
      const person = {name: 'Luca', age: 21};
      comB.onInvoke = (event,data,end) => {
        expect(event).to.be.equal('getPerson');
        end(person);
      };
      comA.invoke('getPerson').then(result => {
        expect(result).to.be.deep.equal(person);
        done();
      });
    });

    it('A should receive the response of invoke with binary data.', (done) => {
      const binary = new ArrayBuffer(200);
      comB.onInvoke = (event,data,end) => {
        expect(event).to.be.equal('getBinary');
        end(binary,true);
      };
      comA.invoke('getBinary').then(result => {
        expect(result).to.be.deep.equal(binary);
        done();
      });
    });

    it('A should receive the same invoked binary data as a response.', (done) => {
      const binary = new ArrayBuffer(200);
      comB.onInvoke = (event,data,end) => {
        expect(event).to.be.equal('getSameBinary');
        end(data,true);
      };
      comA.invoke('getSameBinary',binary,{processComplexTypes: true}).then(result => {
        expect(result).to.be.deep.equal(binary);
        done();
      });
    });

    it('A should receive the response of invoke with MixedJSON data.', (done) => {
      const writeStream = new WriteStream();
      let writtenCode: any[];
      writeStream.onOpen = () => {
        const chunk1 = new ArrayBuffer(20);
        const chunk2 = new ArrayBuffer(25);
        writtenCode = [chunk1,chunk2];
        writeStream.write(chunk1,true);
        writeStream.writeAndClose(chunk2,true,200);
      };

      const car = {avatar: new ArrayBuffer(20), model: 'X1', hp: 500, code: writeStream};
      comB.onInvoke = (event,data,end) => {
        expect(event).to.be.equal('car');

        expect(data.avatar).to.be.deep.equal(car.avatar);
        expect(data.model).to.be.equal(car.model);
        expect(data.hp).to.be.equal(car.hp);

        const codeReadStream: ReadStream = data.code;
        const chunks: any[] = [];
        codeReadStream.onChunk = (chunk) => {
          chunks.push(chunk);
        };
        codeReadStream.onClose = () => {
          expect(chunks).to.be.deep.equal(writtenCode);
          end(1);
        }
        codeReadStream.accept();
      };
      comA.invoke('car',car,{processComplexTypes: true}).then(result => {
        expect(result).to.be.equal(1);
        done();
      });
    });

    it('A should receive the response with MixedJSON data of an invoke.', (done) => {
      let tv;
      let writtenCode: any[];
      comB.onInvoke = (event,data,end) => {
        expect(event).to.be.equal('tv');

        const writeStream = new WriteStream();
        writeStream.onOpen = () => {
          const chunk1 = new ArrayBuffer(20);
          const chunk2 = new ArrayBuffer(25);
          writtenCode = [chunk1,chunk2];
          writeStream.write(chunk1,true);
          writeStream.writeAndClose(chunk2,true,200);
        };

        tv = {avatar: new ArrayBuffer(20), model: 'Y1', code: writeStream};
        end(tv,true);
      };
      comA.invoke('tv').then(result => {
        expect(result.avatar).to.be.deep.equal(tv.avatar);
        expect(result.model).to.be.equal(result.model);

        const codeReadStream: ReadStream = result.code;
        const chunks: any[] = [];
        codeReadStream.onChunk = (chunk) => {
          chunks.push(chunk);
        };
        codeReadStream.onClose = () => {
          expect(chunks).to.be.deep.equal(writtenCode);
          done();
        }
        codeReadStream.accept();
      });
    });

    it('A should receive the err response of an invoke.', (done) => {
      const error = new Error('Some msg');
      error.name = 'SomeName';
      comB.onInvoke = (event,data,end,reject) => {
        expect(event).to.be.equal('getErr');
        reject(error);
      };
      comA.invoke('getErr').catch(err => {
        expect(err.name).to.be.equal(error.name);
        expect(err.message).to.be.equal(error.message);
        done();
      });
    });

    it('A should receive a timeout error by an unknown event invoke.', (done) => {
      comB.onInvoke = () => {};
      comA.invoke('?',undefined,{ackTimeout: 50}).catch(err => {
        expect(err).to.be.instanceof(TimeoutError)
        done();
      });
    });

    it('A should receive a connection lost error by an invoke with connection lost.', (done) => {
      comB.onInvoke = () => {};
      comA.invoke('?').catch(err => {
        expect(err).to.be.instanceof(ConnectionLostError)
        done();
      });
      comA.emitConnectionLost();
    });
  });

  describe('Ping', () => {

    it('B should receive ping.', (done) => {
      comB.onPing = () => done();
      comA.sendPing();
    });

  });

});