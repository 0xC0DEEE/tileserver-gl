#!/usr/bin/env node
'use strict';

process.env.UV_THREADPOOL_SIZE =
    Math.ceil(Math.max(4, require('os').cpus().length * 1.5));

var async = require('async'),
    fs = require('fs'),
    path = require('path');

var clone = require('clone'),
    cors = require('cors'),
    express = require('express'),
    handlebars = require('handlebars'),
    mercator = new (require('sphericalmercator'))(),
    morgan = require('morgan');

var serve_font = require('./serve_font'),
    serve_raster = require('./serve_raster'),
    serve_style = require('./serve_style'),
    serve_vector = require('./serve_vector'),
    utils = require('./utils');

module.exports = function(opts, callback) {
  var app = express().disable('x-powered-by'),
      serving = {
        styles: {},
        raster: {},
        vector: {},
        fonts: { // default fonts, always expose these (if they exist)
          'Open Sans Regular': true,
          'Arial Unicode MS Regular': true
        }
      };

  app.enable('trust proxy');

  callback = callback || function() {};

  if (process.env.NODE_ENV !== 'production' &&
      process.env.NODE_ENV !== 'test') {
    app.use(morgan('dev'));
  }

  var configPath = path.resolve(opts.config);

  var config;
  try {
    config = require(configPath);
  } catch (e) {
    console.log('ERROR: Config file not found or invalid!');
    console.log('       See README.md for instructions and sample data.');
    process.exit(1);
  }

  var options = config.options || {};
  var paths = options.paths || {};
  options.paths = paths;
  paths.root = path.resolve(process.cwd(), paths.root || '');
  paths.styles = path.resolve(paths.root, paths.styles || '');
  paths.fonts = path.resolve(paths.root, paths.fonts || '');
  paths.sprites = path.resolve(paths.root, paths.sprites || '');
  paths.mbtiles = path.resolve(paths.root, paths.mbtiles || '');

  var vector = clone(config.vector || {});
  var composite = {};

  Object.keys(config.styles || {}).forEach(function(id) {
    var item = config.styles[id];
    if (!item.style || item.style.length == 0) {
      console.log('Missing "style" property for ' + id);
      return;
    }

    if (item.vector !== false) {
      app.use('/', serve_style(options, serving.styles, item, id,
        function(mbtiles) {
          var vectorItemId;
          Object.keys(vector).forEach(function(id) {
            if (vector[id].mbtiles == mbtiles) {
              vectorItemId = id;
            }
          });
          if (vectorItemId) { // mbtiles exist in the vector config
            return vectorItemId;
          } else {
            var id = mbtiles.substr(0, mbtiles.lastIndexOf('.')) || mbtiles;
            while (vector[id]) id += '_';
            vector[id] = {
              'mbtiles': mbtiles
            };
            return id;
          }
        }, function(ids) {
            var id = ids.join(',');
            if (ids.length > 1) {
              composite[id] = {
                ids: ids
              };
            }
            return id;
          }, function(font) {
          serving.fonts[font] = true;
        }));
    }
    if (item.raster !== false) {
      app.use('/', serve_raster(options, serving.raster, item, id));
    }
  });

  if (Object.keys(serving.styles).length > 0) {
    // serve fonts only if serving some styles
    app.use('/', serve_font(options, serving.fonts));
  }

  app.use(cors());

  var queue = [];
  Object.keys(vector).forEach(function(id) {
    queue.push(function(callback) {
      var item = vector[id];
      if (!item.mbtiles || item.mbtiles.length == 0) {
        console.log('Missing "mbtiles" property for ' + id);
        return;
      }

      app.use('/', serve_vector(options, serving.vector, item, id, callback));
    });
  });

  async.parallel(queue, function(err, results) {
    Object.keys(composite).forEach(function(id) {
      var item = composite[id];
      app.use('/', serve_vector(options, serving.vector, item, id, null));
    });
  });

  app.get('/styles.json', function(req, res, next) {
    var result = [];
    Object.keys(serving.styles).forEach(function(id) {
      var styleJSON = serving.styles[id];
      result.push({
        version: styleJSON.version,
        name: styleJSON.name,
        id: id,
        url: req.protocol + '://' + req.headers.host + '/styles/' + id + '.json'
      });
    });
    res.send(result);
  });

  var addTileJSONs = function(arr, req, type) {
    Object.keys(serving[type]).forEach(function(id) {
      var info = clone(serving[type][id]);
      if (type == 'vector') {
        info = info.tileJSON;
      }
      info.tiles = utils.getTileUrls(req, info.tiles,
                                     type + '/' + id, info.format);
      arr.push(info);
    });
    return arr;
  };

  app.get('/raster.json', function(req, res, next) {
    res.send(addTileJSONs([], req, 'raster'));
  });
  app.get('/vector.json', function(req, res, next) {
    res.send(addTileJSONs([], req, 'vector'));
  });
  app.get('/index.json', function(req, res, next) {
    res.send(addTileJSONs(addTileJSONs([], req, 'raster'), req, 'vector'));
  });

  //------------------------------------
  // serve web presentations
  app.use('/', express.static(path.join(__dirname, '../public/resources')));

  var templates = path.join(__dirname, '../public/templates');
  var serveTemplate = function(path, template, dataGetter) {
    fs.readFile(templates + '/' + template + '.tmpl', function(err, content) {
      if (err) {
        console.log('Template not found:', err);
      }
      var compiled = handlebars.compile(content.toString());

      app.use(path, function(req, res, next) {
        var data = {};
        if (dataGetter) {
          data = dataGetter(req.params);
          if (!data) {
            return res.status(404).send('Not found');
          }
        }
        return res.status(200).send(compiled(data));
      });
    });
  };

  serveTemplate('/$', 'index', function() {
    var styles = clone(config.styles || {});
    Object.keys(styles).forEach(function(id) {
      var style = styles[id];
      style.name = (serving.styles[id] || serving.raster[id] || {}).name;
      style.serving_style = serving.styles[id];
      style.serving_raster = serving.raster[id];
      if (style.serving_raster) {
        var center = style.serving_raster.center;
        if (center) {
          style.viewer_hash = '#' + center[2] + '/' +
                              center[1].toFixed(5) + '/' +
                              center[0].toFixed(5);

          var centerPx = mercator.px([center[0], center[1]], center[2]);
          style.thumbnail = center[2] + '/' +
              Math.floor(centerPx[0] / 256) + '/' +
              Math.floor(centerPx[1] / 256) + '.png';
        }
      }
    });
    var data = {};
    Object.keys(serving.vector || {}).forEach(function(id) {
      data[id] = clone(serving.vector[id]['tileJSON']);
      var vector = data[id];
      var center = vector.center;
      if (center) {
        vector.viewer_hash = '#' + center[2] + '/' +
                             center[1].toFixed(5) + '/' +
                             center[0].toFixed(5);
      }
    });
    return {
      styles: styles,
      data: data
    };
  });

  serveTemplate('/styles/:id/$', 'viewer', function(params) {
    var id = params.id;
    var style = clone((config.styles || {})[id]);
    if (!style) {
      return null;
    }
    style.id = id;
    style.name = (serving.styles[id] || serving.raster[id]).name;
    style.serving_style = serving.styles[id];
    style.serving_raster = serving.raster[id];
    return style;
  });

  app.use('/raster/:id/$', function(req, res, next) {
    return res.redirect(301, '/styles/' + req.params.id + '/');
  });

  serveTemplate('/vector/:id/$', 'xray', function(params) {
    var id = params.id;
    var vector = (serving.vector[id] || {})['tileJSON'];
    if (!vector) {
      return null;
    }
    vector.id = id;
    return vector;
  });

  var server = app.listen(process.env.PORT || opts.port, function() {
    console.log('Listening at http://%s:%d/',
                this.address().address, this.address().port);

    return callback();
  });

  setTimeout(callback, 1000);
  return {
    app: app,
    server: server
  };
};
