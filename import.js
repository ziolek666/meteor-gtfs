
// importFromZip = function(agency, zipfile) {
importFromZip = function(agency, zipfile) {

    Agency.find({agency_key: agency}).count(function(err, count) {
        if (count > 0) {
            console.log("skipping import for agency", agency, "-- it is already loaded.");
        } else {
            console.log("importing:", agency, zipfile);

            var exec = Npm.require('child_process').exec
            , fs = Npm.require('fs')
            , path = Npm.require('path')
            , csv = Npm.require('csv')
            , async = Npm.require('async')
            , unzip = Npm.require('unzip2')
            , Db = Npm.require('mongodb').Db
            , os = Npm.require('os')
            , q;

            var dir = os.tmpdir() + '/gtfs';

            var GTFSFiles = [
                {
                    fileNameBase: 'agency'
                    , collection: 'agencies'
                },
                {
                    fileNameBase: 'calendar_dates'
                    , collection: 'calendardates'
                },
                {
                    fileNameBase: 'calendar'
                    , collection: 'calendars'
                },
                {
                    fileNameBase: 'fare_attributes'
                    , collection: 'fareattributes'
                },
                {
                    fileNameBase: 'fare_rules'
                    , collection: 'farerules'
                },
                {
                    fileNameBase: 'feed_info'
                    , collection: 'feedinfos'
                },
                {
                    fileNameBase: 'frequencies'
                    , collection: 'frequencies'
                },
                {
                    fileNameBase: 'routes'
                    , collection: 'routes'
                },
                {
                    fileNameBase: 'stop_times'
                    , collection: 'stoptimes'
                },
                {
                    fileNameBase: 'stops'
                    , collection: 'stops'
                },
                {
                    fileNameBase: 'transfers'
                    , collection: 'transfers'
                },
                {
                    fileNameBase: 'trips'
                    , collection: 'trips'
                }
            ];

            //open database and create queue for agency list
            Db.connect(process.env.MONGO_URL, {w: 1}, function(err, db) { 
                if (err) {
                    handleError(err);
                }

                q = async.queue(importGTFS, 1);
                //loop through all agencies specified
                //If the agency_key is a URL, download that GTFS file, otherwise treat 
                //it as an agency_key and get file from gtfs-data-exchange.com
                // process.argv.forEach(function(item) {
                // q.push(item); // zip files
                // console.log(item);
                // });
                q.push({key: agency,
                        zip: zipfile}); // zip files

                q.drain = function(e) {
                    console.log('All agencies completed (1 total)');
                    // db.close();
                    // process.exit();
                }


                function importGTFS(task, cb) {
                    var agency_key = task.key
                    , agency_bounds = {sw: [], ne: []}
                    , agency_zip = task.zip;

                    console.log('Starting ' + agency_key);

                    async.series([
                        unpack,
                        removeDatabase,
                        importFiles,
                        postProcess
                    ], function(e, results){
                        console.log( e || agency_key + ': Completed')
                        cb();
                    });


                    function unpack(cb) {
                        //do download
                        fs.createReadStream(agency_zip)  // give filename
                        // agency_zip  // give file readstream
                            .pipe(unzip.Extract({ path: dir }).on('close', cb))
                            .on('error', handleError);
                    }


                    function removeDatabase(cb) {
                        //remove old db records based on agency_key
                        async.forEach(GTFSFiles, function(GTFSFile, cb){
                            db.collection(GTFSFile.collection, function(e, collection){
                                collection.remove({ agency_key: agency_key }, cb);
                            });
                        }, function(e){
                            cb(e, 'remove');
                        });
                    }


                    function importFiles(cb) {
                        //Loop through each file and add agency_key
                        async.forEachSeries(GTFSFiles, function(GTFSFile, cb){
                            if(GTFSFile){
                                var filepath = path.join(dir, GTFSFile.fileNameBase + '.txt');
                                if (!fs.existsSync(filepath)) return cb();
                                console.log(agency_key + ': ' + GTFSFile.fileNameBase + ' Importing data');
                                db.collection(GTFSFile.collection, function(e, collection){
                                    csv()
                                        .from.path(filepath, {columns: true})
                                        .on('record', function(line, index){
                                            //remove null values
                                            for(var key in line){
                                                if(line[key] === null){
                                                    delete line[key];
                                                }
                                            }
                                            
                                            //add agency_key
                                            line.agency_key = agency_key;

                                            //convert fields that should be int
                                            if(line.stop_sequence){
                                                line.stop_sequence = parseInt(line.stop_sequence, 10);
                                            }
                                            if(line.direction_id){
                                                line.direction_id = parseInt(line.direction_id, 10);
                                            }

                                            //make lat/lon array
                                            if(line.stop_lat && line.stop_lon){
                                                var loc = [parseFloat(line.stop_lon), parseFloat(line.stop_lat)];
                                                // line.loc = { type:'Point', coordinates: loc};
                                                line.loc = loc;//{ type:'Point', coordinates: loc};
                                                
                                                //Calulate agency bounds
                                                if(agency_bounds.sw[0] > loc[0] || !agency_bounds.sw[0]){
                                                    agency_bounds.sw[0] = loc[0];
                                                }
                                                if(agency_bounds.ne[0] < loc[0] || !agency_bounds.ne[0]){
                                                    agency_bounds.ne[0] = loc[0];
                                                }
                                                if(agency_bounds.sw[1] > loc[1] || !agency_bounds.sw[1]){
                                                    agency_bounds.sw[1] = loc[1];
                                                }
                                                if(agency_bounds.ne[1] < loc[1] || !agency_bounds.ne[1]){
                                                    agency_bounds.ne[1] = loc[1];
                                                }
                                            }

                                            //insert into db
                                            collection.insert(line, function(e, inserted) {
                                                if(e) { handleError(e); }
                                            });
                                        })
                                        .on('end', function(count){
                                            cb();
                                        })
                                        .on('error', handleError);
                                });
                            }
                        }, function(e){
                            cb(e, 'import');
                        });
                    }


                    function postProcess(cb) {
                        console.log(agency_key + ':  Post Processing data');

                        async.series([
                            agencyCenter
                            , longestTrip
                            , updatedDate
                        ], function(e, results){
                            cb();
                        });
                    }


                    function agencyCenter(cb) {
                        var agency_center = [
                            (agency_bounds.ne[0] - agency_bounds.sw[0])/2 + agency_bounds.sw[0]
                            , (agency_bounds.ne[1] - agency_bounds.sw[1])/2 + agency_bounds.sw[1]
                        ];

                        db.collection('agencies')
                            .update({agency_key: agency_key}, {$set: {agency_bounds: agency_bounds, agency_center: agency_center}}, cb);
                    }


                    function longestTrip(cb) {
                        /*db.trips.find({agency_key: agency_key}).for.toArray(function(e, trips){
                          async.forEach(trips, function(trip, cb){
                          db.collection('stoptimes', function(e, collection){

                          });
                          console.log(trip);
                          cb();
                          }, cb);
                          });
                          });*/
                        cb();
                    }

                    function updatedDate(cb) {
                        db.collection('agencies')
                            .update({agency_key: agency_key}, {$set: {date_last_updated: Date.now()}}, cb);
                    }
                }
            });


            function handleError(e) {
                console.error(e || 'Unknown Error');
                process.exit(1)
            };
        }
    });

};
