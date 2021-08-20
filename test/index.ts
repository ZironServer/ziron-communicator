import {
  analyseTypeofData,
  BadConnectionError,
  BadConnectionType,
  Transport,
  DataType,
  JSONString,
  PreparedPackage,
  ReadStream,
  StreamCloseCode,
  StreamState,
  TimeoutError,
  WriteStream
} from './../src/index';
import {expect} from 'chai';

const comA1 = new Transport({
  onInvalidMessage: (err) => console.error('A1: Invalid meessage: ', err),
  onListenerError: (err) => console.error('A1: Listener err: ', err),
},true);
const comB1 = new Transport({
  onInvalidMessage: (err) => console.error('B1: Invalid meessage: ', err),
  onListenerError: (err) => console.error('B1: Listener err: ', err),
},true);
const comA2 = new Transport({
  onInvalidMessage: (err) => console.error('A2: Invalid meessage: ', err),
  onListenerError: (err) => console.error('A2: Listener err: ', err),
},true);
const comB2 = new Transport({
  onInvalidMessage: (err) => console.error('B2: Invalid meessage: ', err),
  onListenerError: (err) => console.error('B2: Listener err: ', err),
},true);

//connect
comA1.send = comB1.emitMessage.bind(comB1);
comB1.send = comA1.emitMessage.bind(comA1);

comA2.send = comB2.emitMessage.bind(comB2);
comB2.send = comA2.emitMessage.bind(comA2);

describe('Ziron', () => {

  describe('Transmits', () => {

    [
      {
        title: 'B should receive the transmit with JSON data.',
        data: {name: 'Luca', age: 21},
        expectedData: {name: 'Luca', age: 21},
        expectedDataType: DataType.JSON,
        processComplexTypes: false
      },
      {
        title: 'Transmit with circular JSON data should be handled.',
        data: (() => {
          const data: any = {};
          data.more = data;
          return data;
        })(),
        expectedData: {more: '[Circular]'},
        expectedDataType: DataType.JSON,
        processComplexTypes: false
      },
      {
        title: 'B should receive the transmit with binary data.',
        data: new ArrayBuffer(10),
        expectedData: new ArrayBuffer(10),
        expectedDataType: DataType.Binary,
        processComplexTypes: true
      },
      {
        title: 'B should receive the transmit with JSON string.',
        data: new JSONString('[]'),
        expectedData: [],
        expectedDataType: DataType.JSON,
        processComplexTypes: false
      },
      {
        title: 'B should receive the transmit with MixedJSON (JSON with binary).',
        data: {avatar: new ArrayBuffer(5),cover: new ArrayBuffer(15)},
        expectedData: {avatar: new ArrayBuffer(5),cover: new ArrayBuffer(15)},
        expectedDataType: DataType.JSONWithBinaries,
        processComplexTypes: true
      }
    ].forEach(test => {
      it(test.title, async () => {
        const receivePromise = new Promise((res,rej) => {
          comB1.onTransmit = (event,data,type) => {
            try {
              expect(event).to.be.equal('someEvent');
              expect(data).to.be.deep.equal(test.expectedData);
              expect(type).to.be.equal(test.expectedDataType);
              res();
            }
            catch(e) {rej(e)}
          };
        });
        comA1.transmit('someEvent', test.data, {processComplexTypes: test.processComplexTypes});
        await receivePromise;
      });
    })

    it('B should receive the streamed json transmit data fully.', (done) => {
      const writeStream = new WriteStream();
      const writtenData: any[] = [];
      writeStream.onOpen = async () => {
        //simulate accept package transmit time
        await new Promise((res) => setTimeout(res,10));
        for(let i = 0; i < 500; i++) {
          writtenData.push(i);
          writeStream.write(i);
        }
        writtenData.push(500);
        writeStream.writeAndClose(500,false,200);
      };
      comB1.onTransmit = (event,data: ReadStream,type) => {
        expect(event).to.be.equal('streamJson');
        expect(type).to.be.equal(DataType.Stream);
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
        data.accept(2000);
      };
      comA1.transmit('streamJson',writeStream,{processComplexTypes: true});
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
      comB1.onTransmit = (event,data: ReadStream,type) => {
        expect(event).to.be.equal('streamBinary');
        expect(type).to.be.equal(DataType.Stream);
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
      comA1.transmit('streamBinary',writeStream,{processComplexTypes: true});
    });

    it("A's write stream should be closed when B closes the read stream.", (done) => {
      const writeStream = new WriteStream();
      writeStream.onClose = (code) => {
        expect(code).to.be.equal(505);
        done();
      };
      comB1.onTransmit = (event,data: ReadStream,type) => {
        expect(event).to.be.equal('readStreamClose');
        expect(type).to.be.equal(DataType.Stream);
        expect(data).to.be.instanceof(ReadStream);
        data.close(505)
      };
      comA1.transmit('readStreamClose',writeStream,{processComplexTypes: true});
    });

    it("Ignored read stream should end write stream with an accept timeout.", (done) => {
      WriteStream.acceptTimeout = 60;
      const writeStream = new WriteStream();
      writeStream.onClose = (code) => {
        expect(code).to.be.equal(StreamCloseCode.AcceptTimeout);
        done();
      };
      comB1.onTransmit = (event,data: ReadStream) => {
        expect(event).to.be.equal('streamAcceptTimeout');
      };
      comA1.transmit('streamAcceptTimeout',writeStream,{processComplexTypes: true});
    });


    it("An accept read stream which will not receive anything a certain time should end with ReceiveTimeout.", (done) => {
      const writeStream = new WriteStream();

      comB1.onTransmit = (event,data: ReadStream) => {
        expect(event).to.be.equal('streamReceiveTimeout');

        data.onClose = (code) => {
          expect(code).to.be.equal(StreamCloseCode.ReceiveTimeout);
          done();
        }
        data.accept(60);

      };
      comA1.transmit('streamReceiveTimeout',writeStream,{processComplexTypes: true});
    });

    it('All batch transmits should be received.', (done) => {
      const count = 43;

      let receivedI = 0;
      comB1.onTransmit = (event,data) => {
        expect(event).to.be.equal('batch');
        expect(data).to.be.equal('msg');
        receivedI++;
        if(receivedI === count) done();
      };

      comA1.maxBufferChunkLength = 5
      comA1.limitBatchPackageLength = 2
      for(let i = 0; i < count; i++){
        comA1.transmit('batch','msg',{batch: 50});
      }
      comA1.maxBufferChunkLength = undefined;
    });

    it('Should not send cancelled batch packages.', (done) => {
      const count = 10;

      let receivedI = 0;
      comB1.onTransmit = () => {
        receivedI++;
      };

      const packages: PreparedPackage[] = [];
      for(let i = 0; i < count; i++){
        packages.push(Transport.prepareMultiTransmit('batch','msg'));
        comA1.sendPreparedPackage(packages[i],10);
      }
      packages.forEach(pack => comA1.tryCancelPackage(pack));

      setTimeout(() => {
        expect(receivedI).to.be.equal(0);
        done();
      },50)
    });

    it('Transmit a stream and a connection lost after sending should close the ReadStream after accepting.', (done) => {

      let simulatedBadConnectionPromise;

      comB1.onTransmit = async (event,data: ReadStream) => {
        await simulatedBadConnectionPromise;
        expect(event).to.be.equal('stream');
        expect(data).to.be.instanceOf(ReadStream);
        expect(data.state).to.be.equal(StreamState.Pending);

        data.onClose = (code) => {
          expect(code).to.be.equal(StreamCloseCode.BadConnection);
          done();
          comB1.emitOpen();
        };
        data.accept();
      };

      simulatedBadConnectionPromise = new Promise(async (res) => {
        await comA1.transmit('stream',new WriteStream(),{processComplexTypes: true});
        comB1.emitBadConnection(BadConnectionType.Disconnect);
        res();
      })
    });

  });

  describe('Multi Transmits', () => {

    [
      {
        title: 'B1 and B2 should receive the multi transmit with JSON data.',
        data: {name: 'Luca', age: 21},
        processComplexTypes: false
      },
      {
        title: 'B1 and B2 should receive the multi transmit with MixedJSON (JSON with binary) 1.',
        data: {numbers: [24,24,2,35,35], image: new ArrayBuffer(100)},
        processComplexTypes: true
      },
      {
        title: 'B1 and B2 should receive the multi transmit with MixedJSON (JSON with binary) 2.',
        data: {image: new ArrayBuffer(50), cover: new ArrayBuffer(100)},
        processComplexTypes: true
      },
      {
        title: 'B1 and B2 should receive the multi transmit with binary data.',
        data: new ArrayBuffer(100),
        processComplexTypes: true
      }
    ]
    .forEach(test => {
      it(test.title, async () => {
        const receivePromise = Promise.all([comB1,comB2].map(c => {
          return new Promise((res,rej) =>  {
            c.onTransmit = (event,data) => {
              try {
                expect(event).to.be.equal('person');
                expect(data).to.be.deep.equal(test.data);
                res();
              }
              catch(e) {rej(e);}
            };
          });
        }));

        const prepPackage = Transport.prepareMultiTransmit('person',test.data,
          {processComplexTypes: test.processComplexTypes});
        [comA1,comA2].forEach(c => c.sendPreparedPackage(prepPackage))

        await receivePromise;
      });
    })

  });

  describe('Invokes', () => {

    [
      {
        title: 'A should receive the response of invoke with JSON data.',
        respData: {name: 'Luca', age: 21},
        expectedData: {name: 'Luca', age: 21},
        processComplexTypes: false
      },
      {
        title: 'A should receive the response of invoke with binary data.',
        respData: new ArrayBuffer(200),
        expectedData: new ArrayBuffer(200),
        processComplexTypes: true
      },
      {
        title: 'A should receive the response of invoke but without binary data (processComplexTypes: false).',
        respData: new ArrayBuffer(200),
        expectedData: {},
        processComplexTypes: false
      },
      {
        title: 'A should receive the response of invoke but without read stream (processComplexTypes: false).',
        respData: new WriteStream(),
        expectedData: '[WriteStream]',
        processComplexTypes: false
      }
    ].forEach(test => {
      it(test.title, async () => {
        comB1.onInvoke = (event,_,end) => {
          expect(event).to.be.equal('someEvenet');
          end(test.respData,test.processComplexTypes);
        };
        return comA1.invoke('someEvenet').then(result => {
          expect(result).to.be.deep.equal(test.expectedData);
        });
      });
    })

    it('A should receive the same invoked binary data as a response.', (done) => {
      const binary = new ArrayBuffer(200);
      comB1.onInvoke = (event,data,end) => {
        expect(event).to.be.equal('getSameBinary');
        end(data,true);
      };
      comA1.invoke('getSameBinary',binary,{processComplexTypes: true}).then(result => {
        expect(result).to.be.deep.equal(binary);
        done();
      });
    });

    it('B should receive the invoke with MixedJSON data.', (done) => {

      let writtenCode: any[];
      const writeStream = new WriteStream(() => {
        const chunk1 = new ArrayBuffer(20);
        const chunk2 = new ArrayBuffer(25);
        writtenCode = [chunk1,chunk2];
        writeStream.write(chunk1,true);
        writeStream.writeAndClose(chunk2,true,200);
      });

      const car = {avatar: new ArrayBuffer(20), model: 'X1', hp: 500, code: writeStream};
      comB1.onInvoke = (event,data,end) => {
        expect(event).to.be.equal('car');

        expect(data.avatar).to.be.deep.equal(car.avatar);
        expect(data.model).to.be.equal(car.model);
        expect(data.hp).to.be.equal(car.hp);
        expect(data.code).to.be.instanceOf(ReadStream);

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
      comA1.invoke('car',car,{processComplexTypes: true}).then(result => {
        expect(result).to.be.equal(1);
        done();
      });
    });

    it('A should receive the response with MixedJSON data of an invoke.', (done) => {
      let tv;
      let writtenCode: any[];
      comB1.onInvoke = (event,_,end) => {
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
      comA1.invoke('tv').then(result => {
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
      comB1.onInvoke = (event,_data,_end,reject) => {
        expect(event).to.be.equal('getErr');
        reject(error);
      };
      comA1.invoke('getErr').catch(err => {
        expect(err.name).to.be.equal(error.name);
        expect(err.message).to.be.equal(error.message);
        done();
      });
    });

    it('A should receive a timeout error by an unknown event invoke.', (done) => {
      comB1.onInvoke = () => {};
      comA1.invoke('?',undefined,{ackTimeout: 50}).catch(err => {
        expect(err).to.be.instanceof(TimeoutError)
        done();
      });
    });

    it('A should receive a connection lost error by an invoke with connection lost.', (done) => {
      comB1.onInvoke = () => {};
      comA1.invoke('?').catch(err => {
        expect(err).to.be.instanceof(BadConnectionError)
        done();
        comA1.emitOpen();
      });
      comA1.emitBadConnection(BadConnectionType.Disconnect);
    });

    it('A should receive the invoke response with the data type.', (done) => {
      comB1.onInvoke = (event,_data,end) => {
        expect(event).to.be.equal('event2');
        end({name: 'Leo'});
      };
      comA1.invoke('event2',undefined,{returnDataType: true}).then(res => {
        expect(res).to.be.deep.equal([{name: 'Leo'},DataType.JSON]);
        done();
      });
    });

  });

  describe('Ping/Pong', () => {

    it('B should receive ping.', (done) => {
      comB1.onPing = () => done();
      comA1.sendPing();
    });

    it('B should receive pong.', (done) => {
      comB1.onPong = () => done();
      comA1.sendPong();
    });

  });

  describe('Analyse typeof data', () => {

    [
      {
        data: undefined,
        expectedType: DataType.JSON
      },
      {
        data: null,
        expectedType: DataType.JSON
      },
      {
        data: 10,
        expectedType: DataType.JSON
      },
      {
        data: '',
        expectedType: DataType.JSON
      },
      {
        data: {},
        expectedType: DataType.JSON
      },
      {
        data: [],
        expectedType: DataType.JSON
      },
      {
        data: {persons: [{name: 'Peter'},{name: 'Mauri'}]},
        expectedType: DataType.JSON
      },
      {
        data: new ArrayBuffer(10),
        expectedType: DataType.Binary
      },
      {
        data: new WriteStream(),
        expectedType: DataType.Stream
      },
      {
        data: {images: [new ArrayBuffer(10)]},
        expectedType: DataType.JSONWithBinaries
      },
      {
        data: {images: [new WriteStream()]},
        expectedType: DataType.JSONWithStreams
      },
      {
        data: {images: [new WriteStream()],car: {color: 'black', code: new ArrayBuffer(10)}},
        expectedType: DataType.JSONWithStreamsAndBinary
      },
      {
        data: {images: [new WriteStream(),new ArrayBuffer(10),'']},
        expectedType: DataType.JSONWithStreamsAndBinary
      }
    ].forEach((test,index) => {
      it(`Analyse typeof data test: ${index}`, () => {
        expect(analyseTypeofData(test.data)).to.be.equal(test.expectedType);
      });
    })

  });

  describe('Stability', () => {

    [
      {
        msg: '[]',
        invalid: true
      },
      {
        msg: '10',
        invalid: true
      },
      {
        msg: '{name:Tim}',
        invalid: true
      },
      {
        msg: '1,"someEvent",342',
        invalid: true
      },
      {
        msg: '1,"someEvent",0',
        invalid: false
      },
      {
        msg: '1,10,0',
        invalid: true
      },
      {
        msg: '1,{},0',
        invalid: true
      },
      {
        msg: '1,"someEvent",1',
        invalid: true
      },
      {
        msg: '1,"someEvent",2',
        invalid: true
      },
      {
        msg: new ArrayBuffer(0),
        invalid: true
      },
      {
        msg: new ArrayBuffer(10),
        invalid: true
      },
    ].forEach((test, index) => {

      it(`Transmit stability invalid msg test: ${index}`, () => {
        return new Promise((res,rej) => {
          comB1.onInvalidMessage = (e) => {
            try{
              expect(test.invalid).to.be.true;
              res();
            }
            catch(err) {rej(err)}
          }
          comB1.onTransmit = () => {
            try{
              expect(test.invalid).to.be.false;
              res();
            }
            catch(err) {rej(err)}
          }
          comA1.send(test.msg);
        })
      });

    });

    [
      {
        msg: '[]',
        invalid: true
      },
      {
        msg: '10',
        invalid: true
      },
      {
        msg: '2,"someEvent",0,0',
        invalid: false
      },
      {
        msg: '2,"someEvent","callIdWrong",0',
        invalid: true
      },
    ].forEach((test, index) => {

      it(`Invoke stability invalid msg test: ${index}`, () => {
        return new Promise((res,rej) => {
          comB1.onInvalidMessage = (e) => {
            try{
              expect(test.invalid).to.be.true;
              res();
            }
            catch(err) {rej(err)}
          }
          comB1.onInvoke = (_event,_data,end) => {
            try{
              expect(test.invalid).to.be.false;
              end();
              res();
            }
            catch(err) {rej(err)}
          }
          comA1.send(test.msg);
        })
      });

    });

    it(`Throwing into a listener should call listener error event.`, () => {
      return new Promise((res,rej) => {
        comB1.onListenerError = (err) => {
          try {
            expect(err).to.be.instanceOf(Error);
            expect(err.name).to.be.equal('SomeName');
            expect(err.message).to.be.equal('SomeMsg');
            res();
          }
          catch(err) {rej(err)}
        }
        comB1.onTransmit = () => {
          const err = new Error('SomeMsg');
          err.name = 'SomeName';
          throw err;
        }
        comA1.transmit('event');
      })
    });

    it(`Using the same write stream multiple times should throw an error.`, () => {
      const stream = new WriteStream();
      comA1.transmit('event',stream,{processComplexTypes: true});

      expect(function () {
        comA1.transmit('event',stream,{processComplexTypes: true})
      }).to.throw(Error,'Write-stream already used.');
    });

  });

});